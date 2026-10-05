import { getPaseoClient, useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { hash } from "fast-sha256/sha256.js";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { z } from "zod";
import { translateThinking } from "../shared/translation";

export const thinkingSchema = z.object({
  original: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

type ThinkingData = z.output<typeof thinkingSchema>;

interface ThinkingLabelInput {
  isOmp: boolean;
  translated: string | null;
  phase: ThinkingData["phase"];
  failed: boolean;
}

function thinkingLabel({ isOmp, translated, phase, failed }: ThinkingLabelInput): string {
  if (!isOmp) return "thinking";
  if (translated !== null) return "思考翻译 · 简体中文";
  if (phase === "streaming") return "思考 · 生成中";
  if (failed) return "思考 · 翻译失败";
  return "思考 · 翻译中";
}

interface ThinkingTextStyles {
  heading: StyleProp<TextStyle>;
  toggle: StyleProp<TextStyle>;
  diagnostic: StyleProp<TextStyle>;
  body: StyleProp<TextStyle>;
}

interface ThinkingHeaderProps {
  expanded: boolean;
  label: string;
  onToggle: () => void;
  textStyles: ThinkingTextStyles;
}

function ThinkingHeader({ expanded, label, onToggle, textStyles }: ThinkingHeaderProps) {
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const action = expanded ? "收起" : "展开";
  const marker = expanded ? "−" : "+";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action} ${label}`}
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.button}
    >
      <Text style={textStyles.heading}>
        {marker} {label}
      </Text>
    </Pressable>
  );
}

interface ThinkingBodyProps {
  original: string;
  translated: string | null;
  diagnostic: string | null;
  showOriginal: boolean;
  onToggleOriginal: () => void;
  textStyles: ThinkingTextStyles;
}

function ThinkingBody({
  original,
  translated,
  diagnostic,
  showOriginal,
  onToggleOriginal,
  textStyles,
}: ThinkingBodyProps) {
  const toggleLabel = showOriginal ? "查看中文翻译" : "查看原文";
  const showTranslation = translated !== null && !showOriginal;
  const text = showTranslation ? translated : original;
  return (
    <View style={styles.details}>
      {translated !== null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          onPress={onToggleOriginal}
          style={styles.button}
        >
          <Text style={textStyles.toggle}>{toggleLabel}</Text>
        </Pressable>
      )}
      {diagnostic !== null && <Text style={textStyles.diagnostic}>{diagnostic}</Text>}
      <Text selectable style={textStyles.body}>
        {text}
      </Text>
    </View>
  );
}

export function ThinkingTranslation({
  agentId,
  host,
  item,
  theme,
}: PluginTimelineItemProps<ThinkingData>) {
  const [expanded, setExpanded] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const toggleOriginal = useCallback(() => setShowOriginal((value) => !value), []);
  const translate = useRpc(translateThinking);
  const provider = useQuery({
    queryKey: ["thinking-provider", host.id, agentId],
    queryFn: async () => {
      const snapshot = await getPaseoClient(host.id).agents.ref(agentId).refresh();
      if (!snapshot) throw new Error("Agent provider is unavailable");
      return snapshot.agent.provider;
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const isOmp = provider.data === "omp";
  const sourceHash = useMemo(() => {
    if (!isOmp || item.data.phase !== "complete") return null;
    const digest = hash(new TextEncoder().encode(item.data.original));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, [isOmp, item.data.original, item.data.phase]);
  const canTranslate =
    isOmp && item.data.phase === "complete" && item.data.original.trim().length > 0;
  const translation = useQuery({
    queryKey: ["thinking-translation", host.id, sourceHash],
    queryFn: () => translate({ text: item.data.original }),
    enabled: canTranslate,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  let translated: string | null = null;
  let diagnostic: string | null = null;
  if (isOmp) {
    if (translation.data?.status === "ready") translated = translation.data.translation;
    if (translation.data?.status === "error") diagnostic = translation.data.message;
    else if (translation.isError) diagnostic = "翻译请求失败；保留原文。";
  }
  const label = thinkingLabel({
    isOmp,
    translated,
    phase: item.data.phase,
    failed: diagnostic !== null,
  });
  const textStyles = useMemo<ThinkingTextStyles>(() => {
    const muted = { color: theme.colors.foregroundMuted };
    const foreground = { color: theme.colors.foreground };
    return {
      heading: [styles.heading, muted],
      toggle: [styles.heading, foreground],
      diagnostic: [styles.diagnostic, muted],
      body: [styles.body, muted],
    };
  }, [theme.colors.foregroundMuted, theme.colors.foreground]);
  return (
    <View style={styles.row}>
      <ThinkingHeader
        expanded={expanded}
        label={label}
        onToggle={toggleExpanded}
        textStyles={textStyles}
      />
      {expanded && (
        <ThinkingBody
          original={item.data.original}
          translated={translated}
          diagnostic={diagnostic}
          showOriginal={showOriginal}
          onToggleOriginal={toggleOriginal}
          textStyles={textStyles}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginVertical: 4 },
  button: { paddingVertical: 6 },
  details: { paddingLeft: 12, paddingBottom: 8 },
  heading: { fontSize: 13 },
  diagnostic: { fontSize: 12, marginBottom: 6 },
  body: { fontSize: 14, lineHeight: 21 },
});
