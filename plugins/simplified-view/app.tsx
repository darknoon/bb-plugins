import { useEffect, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { BUBBLE_COLORS, COLOR_KEY, colorInk, colorValue } from "./palette";
import { classifyRows, latestTurn, type TimelineRowInput } from "./classify";

/** Thread plugin metadata key; `true` turns the simplified view on. */
export const METADATA_KEY = "simplified";
const ROW_ATTR = "data-bb-simplified";
const LIST_ATTR = "data-bb-simplified-list";
const LABEL_ATTR = "data-bb-simplified-label";
const AGENT_ATTR = "data-bb-simplified-agent"; // "read" | "unread"
const HUMAN_ATTR = "data-bb-simplified-human";
const COMPOSER_ATTR = "data-bb-simplified-composer";
const WORKING_ATTR = "data-bb-simplified-working";
const COLOR_VAR = "--bb-simplified-user";
const INK_VAR = "--bb-simplified-user-ink";
const BUSY_STATUSES = new Set(["starting", "active", "stopping"]);

// --- Per-thread on/off, shared by the menu action and the overlay ----------
const enabled = new Map<string, boolean>();
const colors = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;
function setEnabled(threadId: string, value: boolean): void {
  if (enabled.get(threadId) === value) return;
  enabled.set(threadId, value);
  version++;
  for (const listener of listeners) listener();
}
function setColor(threadId: string, value: string | null): void {
  if (colors.get(threadId) === value) return;
  colors.set(threadId, value);
  version++;
  for (const listener of listeners) listener();
}
function storeMetadata(threadId: string, metadata: unknown): void {
  setEnabled(threadId, readFlag(metadata));
  const raw =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)[COLOR_KEY]
      : null;
  setColor(threadId, colorValue(raw) === null ? null : (raw as string));
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
function readFlag(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>)[METADATA_KEY] === true
  );
}

// --- Styles ----------------------------------------------------------------
const STYLE = `
/* bb's "Working..." line becomes a typing bubble: three pulsing dots. */
[${WORKING_ATTR}] { padding-inline: 0 !important; }
[${WORKING_ATTR}] > span {
  display: inline-flex !important; align-items: center; justify-content: center;
  width: 56px; height: 36px; border-radius: 18px;
  background: var(--surface-recessed) !important; animation: none !important;
  font-size: 0 !important; color: transparent !important; -webkit-text-fill-color: transparent !important;
}
[${WORKING_ATTR}] > span::before {
  content: ""; width: 8px; height: 8px; border-radius: 50%; margin-right: 24px;
  animation: bb-simplified-dots 1.2s ease-in-out infinite;
}
@keyframes bb-simplified-dots {
  0%, 100% { background: color-mix(in oklab, var(--foreground) 55%, transparent);
    box-shadow: 12px 0 color-mix(in oklab, var(--foreground) 22%, transparent), 24px 0 color-mix(in oklab, var(--foreground) 22%, transparent); }
  33% { background: color-mix(in oklab, var(--foreground) 22%, transparent);
    box-shadow: 12px 0 color-mix(in oklab, var(--foreground) 55%, transparent), 24px 0 color-mix(in oklab, var(--foreground) 22%, transparent); }
  66% { background: color-mix(in oklab, var(--foreground) 22%, transparent);
    box-shadow: 12px 0 color-mix(in oklab, var(--foreground) 22%, transparent), 24px 0 color-mix(in oklab, var(--foreground) 55%, transparent); }
}
@media (prefers-reduced-motion: reduce) { [${WORKING_ATTR}] > span::before { animation-duration: 0s; } }
/* Composer: one pill with + | text | mic | send, nothing underneath. */
[${COMPOSER_ATTR}] [data-follow-up-composer-footer],
[${COMPOSER_ATTR}] button[aria-label^="Provider, model"],
[${COMPOSER_ATTR}] button[aria-label="Send options"],
[${COMPOSER_ATTR}] [data-plugin-composer-action-plugin] { display: none !important; }
/* Concentric: 32px circles inset 8px from every edge, so radius = 16 + 8. */
[${COMPOSER_ATTR}] form[data-promptbox] { border-radius: 24px !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-main] {
  display: flex !important; flex-direction: row !important; align-items: flex-end !important;
}
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-editor-scroll] {
  min-height: 0 !important; max-height: 40vh; padding: 12px 4px !important;
}
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-input-region] [data-promptbox-standard-actions] { display: none !important; }
/* 7px margins + the form's 1px border = 8px insets. */
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > * { padding: 0 !important; margin-bottom: 7px !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > :first-child { margin-left: 7px !important; flex: 0 0 auto !important; width: auto !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > :last-child { margin-right: 7px !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-send-menu] { margin-left: 4px !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] button { margin-inline: 0 !important; }
/* Compact (mobile) form: no +, a 40px button in a 50px pill: 5px insets, radius 20 + 5. */
[${COMPOSER_ATTR}] form[data-promptbox][data-promptbox-compact] { border-radius: 25px !important; }
[${COMPOSER_ATTR}] form[data-promptbox-compact] [data-promptbox-editor-scroll] { padding-left: 16px !important; }
[${COMPOSER_ATTR}] form[data-promptbox-compact] [data-promptbox-action-row] > :last-child { margin: 0 4px 4px 0 !important; }
/* Phones, focused (not compact): bb grows the buttons to 40px touch targets.
   Same concentric rule: 50px pill, 5px insets, radius 20 + 5. */
@media (pointer: coarse) and (max-width: 767px) {
  [${COMPOSER_ATTR}] form[data-promptbox]:not([data-promptbox-compact]) { border-radius: 25px !important; }
  [${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) form:not([data-promptbox-compact]) [data-promptbox-editor-scroll] {
    min-height: 48px !important; padding-block: 10px !important; box-sizing: border-box;
  }
  [${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) form:not([data-promptbox-compact]) [data-promptbox-action-row] > * { margin-bottom: 4px !important; }
  [${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) form:not([data-promptbox-compact]) [data-promptbox-action-row] > :first-child { margin-left: 4px !important; }
  [${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) form:not([data-promptbox-compact]) [data-promptbox-action-row] > :last-child { margin-right: 4px !important; }
}
/* Voice recording replaces the + group: centre it instead of using + spacing. */
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > [data-promptbox-voice-controls][data-promptbox-voice-controls] {
  margin: 0 !important; align-self: center !important; flex: 1 1 auto !important;
}
/* Its end buttons sit as far from the side as from the top: 7px + 1px border
   on desktop (32px buttons), 4px + 1px in the compact form (40px buttons). */
[${COMPOSER_ATTR}] [data-promptbox-voice-controls] > div { padding-inline: 7px !important; }
[${COMPOSER_ATTR}] form[data-promptbox-compact] [data-promptbox-voice-controls] > div { padding-inline: 4px !important; }
[${COMPOSER_ATTR}] p.is-editor-empty[data-placeholder]::before { content: "Message" !important; }
[${COMPOSER_ATTR}] [data-promptbox-send-menu], [${COMPOSER_ATTR}] [data-promptbox-action-row] button { border-radius: 9999px !important; }
[${COMPOSER_ATTR}][style*="${COLOR_VAR}"] [data-promptbox-send-menu]:has(button[data-promptbox-submit-action]:not(:disabled)) {
  background: var(${COLOR_VAR}) !important;
}
[${COMPOSER_ATTR}][style*="${COLOR_VAR}"] button[data-promptbox-submit-action]:not(:disabled) { color: var(${INK_VAR}) !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] { display: contents !important; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > :first-child { order: -1; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-input-region] { flex: 1 1 auto; min-width: 0; order: 0; }
[${COMPOSER_ATTR}]:not([data-follow-up-composer-expanded="true"]) [data-promptbox-action-row] > :last-child { order: 1; flex: 0 0 auto !important; justify-content: flex-end !important; }
[${LABEL_ATTR}] { display: none !important; }
/* User bubbles as wide as agent bubbles (bb caps them at 70%). */
[${HUMAN_ATTR}] [data-message-column] > .ml-auto { max-width: 85% !important; }
/* Chat-app bubble shape for both sides: snug padding, round corners. */
[${HUMAN_ATTR}] .rounded-xl.bg-surface-recessed,
[${AGENT_ATTR}] [data-sidebar-swipe-selectable] > [data-markdown-preview] {
  padding: 7px 13px !important; border-radius: 18px !important; line-height: 1.45;
}
/* The user's bubbles are filled with the thread's color. */
[${LIST_ATTR}][style*="${COLOR_VAR}"] [${HUMAN_ATTR}] .rounded-xl.bg-surface-recessed {
  background: var(${COLOR_VAR}); border-color: transparent;
}
[${LIST_ATTR}][style*="${COLOR_VAR}"] [${HUMAN_ATTR}] .rounded-xl.bg-surface-recessed * {
  color: var(${INK_VAR}) !important;
}
/* Chips inside a colored bubble (inline code, code blocks, @mentions,
   attachments): tint them with the text color instead of bb's gray. */
[${LIST_ATTR}][style*="${COLOR_VAR}"] [${HUMAN_ATTR}] .rounded-xl.bg-surface-recessed :is(code:not(pre code), .bg-surface-recessed, .bg-surface-raised, .prompt-mention-pill) {
  background: color-mix(in oklab, var(${INK_VAR}) 14%, transparent) !important;
  border-color: color-mix(in oklab, var(${INK_VAR}) 22%, transparent) !important;
  box-shadow: none !important;
}
[${LIST_ATTR}][style*="${COLOR_VAR}"] [${HUMAN_ATTR}] .rounded-xl.bg-surface-recessed blockquote {
  border-left-color: color-mix(in oklab, var(${INK_VAR}) 45%, transparent) !important;
  opacity: 0.85;
}
/* No "New" divider: unread replies get a brighter bubble instead. */
[${LIST_ATTR}] [data-timeline-window-key^="divider:"] { display: none !important; }
[${LIST_ATTR}] [data-timeline-items][data-timeline-virtual-spacer] > [data-timeline-window-key^="divider:"] { display: block !important; height: 1px !important; overflow: hidden !important; visibility: hidden !important; }
/* Agent replies as left-side bubbles, matching the user's bubble. */
[${AGENT_ATTR}] [data-sidebar-swipe-selectable] > [data-markdown-preview] {
  width: fit-content; max-width: 85%;
  border: 0; background: var(--surface-recessed);
}
[${AGENT_ATTR}] [data-sidebar-swipe-selectable] > [data-markdown-preview] > :last-child { margin-bottom: 0 !important; }
[${AGENT_ATTR}="unread"] [data-sidebar-swipe-selectable] > [data-markdown-preview] {
  /* Unread: a step stronger fill than read replies. */
  background: color-mix(in oklab, var(--foreground) 12%, transparent);
}
[${ROW_ATTR}="hide"] { display: none !important; }
/* bb marks the windowed items container, not individual realized rows.
   Its height cache ignores 0px measurements, so display:none leaves stale
   heights and can replace visible messages with a window spacer. Keep both
   the measured 1px row and its flex gap in layout, including on mode changes. */
[data-timeline-items][data-timeline-virtual-spacer] > [${ROW_ATTR}="hide"] { display: block !important; height: 1px !important; overflow: hidden !important; }
[data-timeline-items][data-timeline-virtual-spacer] > [${ROW_ATTR}="hide"] > * { visibility: hidden !important; }
`;

// --- DOM pass ----------------------------------------------------------------
const TOP_LEVEL_ROWS =
  '[data-timeline-row-list="top-level"] > [data-timeline-items] > [data-timeline-row-id]';

// Latest turn seen while each thread was idle. bb reports "running" a moment
// before the sent message renders; without this the previous reply flickers.
const finishedTurns = new Map<string, string | null>();

function applyToDom(threadId: string, running: boolean, color: string | null): void {
  const prefix = `${threadId}:`;
  const elements = [
    ...document.querySelectorAll<HTMLElement>(TOP_LEVEL_ROWS),
  ].filter((el) => el.getAttribute("data-timeline-row-id")!.startsWith(prefix));
  const inputs: TimelineRowInput[] = elements.map((el) => ({
    id: el.getAttribute("data-timeline-row-id")!,
    isMessageColumn:
      el.firstElementChild?.hasAttribute("data-message-column") ?? false,
    isSteer: [...el.querySelectorAll("[data-message-column] span")].some(
      (span) => span.textContent?.trim() === "Steer",
    ),
  }));
  if (!running) finishedTurns.set(threadId, latestTurn(threadId, inputs));
  const visibility = classifyRows(
    threadId,
    inputs,
    running,
    finishedTurns.get(threadId) ?? null,
  );
  const lists = new Set<HTMLElement>();
  const divider = document.querySelector(
    '[data-timeline-row-list="top-level"] [data-timeline-window-key^="divider:"]',
  );
  elements.forEach((el, i) => {
    try {
      tagRow(el, i);
    } catch (error) {
      // One odd row must not leave the rest of the thread unstyled.
      console.error("[simplified-view] row", inputs[i]?.id, error);
    }
  });
  function tagRow(el: HTMLElement, i: number): void {
    const next = visibility.get(inputs[i]!.id) ?? "show";
    if (el.getAttribute(ROW_ATTR) !== next) el.setAttribute(ROW_ATTR, next);
    const isAgent =
      next === "show" &&
      inputs[i]!.id.slice(threadId.length + 1).startsWith("assistant:");
    const agent = !isAgent
      ? null
      : divider !== null &&
          divider.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
        ? "unread"
        : "read";
    const isHuman = next === "show" && inputs[i]!.isMessageColumn && !isAgent;
    if (isHuman !== el.hasAttribute(HUMAN_ATTR)) el.toggleAttribute(HUMAN_ATTR, isHuman);
    if (agent === null) el.removeAttribute(AGENT_ATTR);
    else if (el.getAttribute(AGENT_ATTR) !== agent) el.setAttribute(AGENT_ATTR, agent);
    const list = el.closest<HTMLElement>('[data-timeline-row-list="top-level"]');
    if (list) lists.add(list);
    // The "Steer" label above mid-turn messages is noise here.
    if (next === "show") {
      for (const span of el.querySelectorAll<HTMLElement>("[data-message-column] span")) {
        if (span.textContent?.trim() === "Steer" && span.parentElement && !span.parentElement.hasAttribute(LABEL_ATTR)) {
          span.parentElement.setAttribute(LABEL_ATTR, "");
        }
      }
    }
  }
  for (const list of document.querySelectorAll<HTMLElement>(`[${LIST_ATTR}]`)) {
    if (!lists.has(list)) {
      list.removeAttribute(LIST_ATTR);
      list.style.removeProperty(COLOR_VAR);
      list.style.removeProperty(INK_VAR);
    }
  }
  // bb's "Working..." line sits next to the list, outside the rows.
  const working = new Set<Element>();
  for (const list of lists) {
    const scope = list.closest("[data-scroll-attached]") ?? list.parentElement;
    for (const span of scope?.querySelectorAll("div.min-h-7 > span.animate-shine") ?? []) {
      working.add(span.parentElement!);
    }
  }
  for (const el of document.querySelectorAll(`[${WORKING_ATTR}]`)) {
    if (!working.has(el)) el.removeAttribute(WORKING_ATTR);
  }
  for (const el of working) if (!el.hasAttribute(WORKING_ATTR)) el.setAttribute(WORKING_ATTR, "");
  const listState = running ? "running" : "idle";
  // Tag the composer in the same pane as this thread's timeline.
  const composers = new Set<Element>();
  for (const list of lists) {
    let pane: HTMLElement | null = list;
    while (pane && !pane.querySelector("[data-follow-up-composer]")) pane = pane.parentElement;
    const composer = pane?.querySelector("[data-follow-up-composer]");
    if (composer) composers.add(composer);
  }
  for (const el of document.querySelectorAll(`[${COMPOSER_ATTR}]`)) {
    if (!composers.has(el)) {
      el.removeAttribute(COMPOSER_ATTR);
      (el as HTMLElement).style.removeProperty(COLOR_VAR);
      (el as HTMLElement).style.removeProperty(INK_VAR);
    }
  }
  for (const el of composers) {
    if (!el.hasAttribute(COMPOSER_ATTR)) el.setAttribute(COMPOSER_ATTR, "");
    const style = (el as HTMLElement).style;
    if (color === null) {
      style.removeProperty(COLOR_VAR);
      style.removeProperty(INK_VAR);
    } else if (style.getPropertyValue(COLOR_VAR) !== color) {
      style.setProperty(COLOR_VAR, color);
      style.setProperty(INK_VAR, colorInk(color));
    }
  }
  for (const list of lists) {
    if (list.getAttribute(LIST_ATTR) !== listState) list.setAttribute(LIST_ATTR, listState);
    if (color === null) {
      list.style.removeProperty(COLOR_VAR);
      list.style.removeProperty(INK_VAR);
    } else if (list.style.getPropertyValue(COLOR_VAR) !== color) {
      list.style.setProperty(COLOR_VAR, color);
      list.style.setProperty(INK_VAR, colorInk(color));
    }
  }
}

function clearDom(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`[${COMPOSER_ATTR}]`)) {
    el.removeAttribute(COMPOSER_ATTR);
    el.style.removeProperty(COLOR_VAR);
    el.style.removeProperty(INK_VAR);
  }
  for (const el of document.querySelectorAll(`[${AGENT_ATTR}]`)) el.removeAttribute(AGENT_ATTR);
  for (const el of document.querySelectorAll(`[${LABEL_ATTR}]`)) el.removeAttribute(LABEL_ATTR);
  for (const el of document.querySelectorAll(`[${ROW_ATTR}]`)) el.removeAttribute(ROW_ATTR);
  for (const el of document.querySelectorAll<HTMLElement>(`[${LIST_ATTR}]`)) {
    el.removeAttribute(LIST_ATTR);
    el.style.removeProperty(COLOR_VAR);
    el.style.removeProperty(INK_VAR);
  }
  for (const el of document.querySelectorAll(`[${HUMAN_ATTR}]`)) el.removeAttribute(HUMAN_ATTR);
  for (const el of document.querySelectorAll(`[${WORKING_ATTR}]`)) el.removeAttribute(WORKING_ATTR);
}

// --- Overlay: owns the DOM pass for the thread in view ----------------------
function SimplifiedTimeline() {
  const { threadId } = useBbContext();
  const sdk = useSdk();
  useStoreVersion();
  const [loadError, setLoadError] = useState(false);
  const sidebar = experimental_useSidebarThreads();
  const status = sidebar.threads.find((t) => t.id === threadId)?.status;
  const running = status !== undefined && BUSY_STATUSES.has(status);
  const on = threadId !== null && enabled.get(threadId) === true;
  const color = colorValue(threadId === null ? null : colors.get(threadId));

  useEffect(() => {
    // Refetch on every visit: another client or an agent may have changed it.
    if (threadId === null) return;
    let cancelled = false;
    sdk.threads.getPluginMetadata({ threadId }).then(
      (metadata) => {
        if (!cancelled) storeMetadata(threadId, metadata);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId, loadError]);

  useEffect(() => {
    if (!on || threadId === null) return;
    const style = document.createElement("style");
    style.setAttribute("data-bb-simplified-style", "");
    style.textContent = STYLE;
    document.head.append(style);
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyToDom(threadId, running, color);
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    applyToDom(threadId, running, color);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      clearDom();
      style.remove();
    };
  }, [on, threadId, running, color]);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "simplified-timeline",
    component: SimplifiedTimeline,
  });

  app.slots.experimental_threadAction<number>({
    id: "toggle-simplified-view",
    title: "Simplified view",
    icon: "EyeOff",
    group: "settings",
    useData: ({ threadIds }) => {
      const sdk = useSdk();
      const current = useStoreVersion();
      const missing = threadIds.filter((id) => !enabled.has(id));
      const key = missing.join(",");
      useEffect(() => {
        if (missing.length === 0) return;
        let cancelled = false;
        sdk.threads
          .experimental_listPluginMetadata({ threadIds: missing })
          .then(({ threads }) => {
            if (cancelled) return;
            const seen = new Set<string>();
            for (const entry of threads) {
              seen.add(entry.threadId);
              storeMetadata(entry.threadId, entry.metadata);
            }
            for (const id of missing) if (!seen.has(id)) setEnabled(id, false);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sdk, key]);
      return current;
    },
    item: ({ thread, sdk }) => {
      const isOn = enabled.get(thread.id) === true;
      return {
        label: isOn ? "Show full timeline" : "Simplified view",
        icon: isOn ? "Eye" : "EyeOff",
        run: async () => {
          const next = !isOn;
          setEnabled(thread.id, next);
          try {
            await sdk.threads.updatePluginMetadata({
              threadId: thread.id,
              ...(next ? { set: { [METADATA_KEY]: true } } : { remove: [METADATA_KEY] }),
            });
          } catch (error) {
            setEnabled(thread.id, isOn);
            throw error;
          }
        },
      };
    },
  });

  app.slots.experimental_threadAction<number>({
    id: "simplified-bubble-color",
    title: "Bubble color",
    icon: "Palette",
    group: "settings",
    order: 10,
    useData: () => useStoreVersion(),
    item: ({ thread, sdk }) => {
      if (enabled.get(thread.id) !== true) return null;
      const current = colors.get(thread.id) ?? null;
      return {
        label: "Bubble color",
        icon: "Palette",
        choices: {
          items: [
            { id: "none", label: "Default", selected: current === null },
            ...BUBBLE_COLORS.map((c) => ({ id: c.id, label: c.label, selected: current === c.id })),
          ],
        },
        run: async ({ value }) => {
          const next = value === undefined || value === "none" ? null : value;
          setColor(thread.id, next);
          try {
            await sdk.threads.updatePluginMetadata({
              threadId: thread.id,
              ...(next === null ? { remove: [COLOR_KEY] } : { set: { [COLOR_KEY]: next } }),
            });
          } catch (error) {
            setColor(thread.id, current);
            throw error;
          }
        },
      };
    },
  });
});
