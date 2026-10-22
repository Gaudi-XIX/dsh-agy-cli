// dsh-agy-link client half (browser). Integrated into native DSH settings, sidebar footer, and header.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { AccountPoolData, FamilyQuotaInfo, ManagedAccount, ModelQuotaInfo } from '../common/pool-types.ts';
import { BRAND_COLORS, BRAND_PATHS, UI_PATHS } from './brand-icons.ts';
import { installAgyToolView } from './toolview.ts';
import { installMermaidRendering } from './mermaid.ts';
import { en, es, NS, ptBR, zh, type AgyLocaleKey } from './locales.ts';
import { installReasoningFollow } from './reasoning.ts';
import { installImageEnhancer } from './images.ts';
import { installDecisionChips } from './decisions.ts';


type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
	useRef: <S>(initial: S) => { current: S };
};
const R = require('react') as ReactApi;
const { createElement: h, useState, useEffect, useRef } = R;

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	open?: (url: string, target?: string) => void;
	addEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
	removeEventListener?: (type: string, listener: (ev: any) => void, useCapture?: boolean) => void;
};

export const name = 'dsh-agy-provider-client';
// Cordis inject entries are hard dependencies: accessing a service not listed
// here throws ("cannot get property X without inject"). locale must be declared
// for ctx.locale to be readable (issue #24). dsh-web-app ships dsh-client-locale.
export const inject = ['slots', 'locale'];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; key?: string; id: string; order?: number; label?: string | (() => string); locale?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

interface StatusPayload {
	bin?: string | null;
	version?: string | null;
	dormantReason?: string | null;
	enabled?: boolean;
	permissionMode?: string;
	workspaceRoot?: string;
	defaultModel?: string;
	defaultEffort?: string;
	auth?: {
		phase: string;
		accountId?: string;
		url?: string;
		qrDataUrl?: string;
		startedAt?: number;
		expiresAt?: number;
		/**
		 * Keyring OAuth token lifetime. Not to be confused with `expiresAt`, which
		 * belongs to a login-flow QR code. These two drive the "凭据 N 分钟后过期"
		 * line — a renewal that silently fails has to be readable here, otherwise
		 * the panel looks fine right up until the quota card goes empty.
		 */
		tokenExpiresAt?: string | null;
		tokenExpiresInSeconds?: number | null;
		/** Whether the host is running the automatic keep-alive. */
		keepalive?: boolean;
		/** Outcome of the last renewal attempt: 'completed' | 'not-rotated' | 'rejected' | 'failed'. */
		keepaliveLastReason?: string | null;
		/** Why that attempt failed, when it did. */
		keepaliveLastDetail?: string | null;
		message?: string;
	};
	quotaError?: 'unauthorized' | 'network' | null;
	pool?: AccountPoolData;
	poolAuth?: {
		phase: 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed';
		stagingId?: string;
		alias?: string;
		url?: string;
		mode?: 'auto' | 'manual';
		browserOpened?: boolean;
		code?: string;
	};
	catalog?: { source: string; count: number; lastError: string | null };
	catalogModels?: ReadonlyArray<{ id: string; name: string }>;
	hiddenModels?: readonly string[];
	bindings?: number;
	lastRun?: { ok: boolean; code: string; durationMs: number; model: string } | null;
}

interface ToastNotice {
	text: string;
	type: 'success' | 'info' | 'warn' | 'error';
	id: number;
}

const base = win.location?.origin ?? '';

// Module-level cache for instant remount rendering
let statusCache: StatusPayload | null = null;

async function getStatus(): Promise<StatusPayload | null> {
	try {
		// A bounded fetch: the poll loop must never stack behind a hung request
		// (undici/browser defaults can park far longer than one poll period).
		const init: Record<string, unknown> = {};
		if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as { timeout?: unknown }).timeout === 'function') {
			init.signal = (AbortSignal as { timeout: (ms: number) => unknown }).timeout(5000);
		}
		const res = await win.fetch?.(base + '/plugins/agy-link/status', init);
		if (!res || !res.ok) return null;
		const payload = (await res.json()) as StatusPayload;
		statusCache = payload;
		return payload;
	} catch {
		return null;
	}
}

async function postJson(path: string, body: Record<string, unknown>): Promise<any> {
	try {
		const res = await win.fetch?.(base + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res) return null;
		try {
			const payload = await res.json();
			// Surface HTTP failure as ok:false so callers can distinguish
			// "saved" from "server refused" instead of always toasting success.
			if (!res.ok && payload !== null && typeof payload === 'object') {
				return { ok: false, ...(payload as Record<string, unknown>) };
			}
			return payload;
		} catch {
			return { ok: res.ok };
		}
	} catch {
		return null;
	}
}

// ---- shared status polling ----
// ONE module-level fetch loop serves every mounted consumer (the provider card
// in the host's Models settings page). Per-component 3s loops used to stack
// (several full payload fetches per interval), had no overlap
// guard, and let a slow stale response overwrite a newer one.
const statusListeners = new Set<(s: StatusPayload) => void>();
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let statusFetchSeq = 0;

function notifyStatus(st: StatusPayload): void {
	statusCache = st;
	for (const fn of [...statusListeners]) {
		try { fn(st); } catch { /* a dead consumer must not kill the loop */ }
	}
}

async function statusPollTick(): Promise<void> {
	const seq = ++statusFetchSeq;
	const st = await getStatus();
	// A slow response from an older tick must never overwrite newer data.
	if (st !== null && seq === statusFetchSeq) notifyStatus(st);
}

function ensureStatusPolling(): void {
	if (statusPollTimer !== null) return;
	void statusPollTick();
	statusPollTimer = setInterval(() => { void statusPollTick(); }, 3000);
}

function stopStatusPollingIfIdle(): void {
	if (statusListeners.size === 0 && statusPollTimer !== null) {
		clearInterval(statusPollTimer);
		statusPollTimer = null;
	}
}

/**
 * Subscribe a component to the shared status poll. Returns the latest
 * snapshot plus a manual refresh that keeps the last good snapshot on a
 * transient failure (a failed refresh used to flip the whole panel back to
 * its loading state).
 */
function useAgyStatus(): { status: StatusPayload | null; refresh: () => Promise<void> } {
	const [status, setStatus] = useState<StatusPayload | null>(statusCache);
	useEffect(() => {
		statusListeners.add(setStatus);
		ensureStatusPolling();
		return () => {
			statusListeners.delete(setStatus);
			stopStatusPollingIfIdle();
		};
	}, []);
	const refresh = async (): Promise<void> => {
		const st = await getStatus();
		if (st !== null) notifyStatus(st);
	};
	return { status, refresh };
}

/**
 * Format reset timestamp into readable date/time + relative countdown.
 */
function formatQuotaWindow(t: (key: AgyLocaleKey) => string, resetTimeStr?: string): {
	resetText: string;
} {
	if (!resetTimeStr) return { resetText: '' };
	try {
		const d = new Date(resetTimeStr);
		const diffMs = d.getTime() - Date.now();
		if (diffMs <= 0) return { resetText: '' };

		const totalMins = Math.ceil(diffMs / 60000);
		const days = Math.floor(totalMins / 1440);
		const hours = Math.floor((totalMins % 1440) / 60);
		const mins = totalMins % 60;
		const isWeekly = days >= 1;

		const countdown = days > 0
			? `${days}${t('duration.day')} ${hours}${t('duration.hour')}`
			: hours > 0 ? `${hours}${t('duration.hour')} ${mins}${t('duration.minute')}` : `${mins}${t('duration.minute')}`;
		const hh = d.getHours().toString().padStart(2, '0');
		const mm = d.getMinutes().toString().padStart(2, '0');
		const resetText = isWeekly
			? `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} (${countdown})`
			: `${hh}:${mm} (${countdown})`;

		return { resetText };
	} catch {
		return { resetText: '' };
	}
}

type BrandKey = keyof typeof BRAND_PATHS;
type UiIconKey = keyof typeof UI_PATHS;

/** Inline brand logo (Gemini / Claude / OpenAI) as a crisp SVG mark. */
function brandIcon(key: BrandKey, size = 13): unknown {
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
	}, h('path', { d: BRAND_PATHS[key], fill: BRAND_COLORS[key] }));
}

/** Clean outline/filled SVG icon (Lucide-style), zero emoji dependency. */
function uiIcon(key: UiIconKey, size = 12, color = 'currentColor'): unknown {
	const p = UI_PATHS[key];
	const isFilled = key === 'star';
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-1.5px', flexShrink: 0 },
	}, h('path', {
		d: p,
		fill: isFilled ? color : 'none',
		stroke: isFilled ? 'none' : color,
		'stroke-width': isFilled ? undefined : 2,
		'stroke-linecap': isFilled ? undefined : 'round',
		'stroke-linejoin': isFilled ? undefined : 'round',
	}));
}

const FAMILY_BRAND: Record<'google' | 'anthropic' | 'openai', BrandKey> = {
	google: 'gemini',
	anthropic: 'claude',
	openai: 'openai',
};

let agyIconSeq = 0;

/** Antigravity mark: gradient orb with an orbit ring (product has no public simple-icon). */
function agyIcon(size = 14): unknown {
	const gid = `agy-g${++agyIconSeq}`;
	return h('svg', {
		viewBox: '0 0 24 24',
		width: size,
		height: size,
		'aria-hidden': true,
		style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0 },
	},
		h('defs', null,
			h('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' },
				h('stop', { offset: '0', 'stop-color': '#4C8DFF' }),
				h('stop', { offset: '1', 'stop-color': '#A96BFF' }),
			),
		),
		h('circle', { cx: 12, cy: 12, r: 6, fill: `url(#${gid})` }),
		h('ellipse', {
			cx: 12, cy: 12, rx: 10.4, ry: 3.9,
			fill: 'none', stroke: `url(#${gid})`, 'stroke-width': 1.4,
			transform: 'rotate(-18 12 12)',
		}),
	);
}

const GLOBAL_CSS = `
@keyframes agy-spin {
	0% { transform: rotate(0deg); }
	100% { transform: rotate(360deg); }
}

:root, body {
	--agy-font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #ffffff);
	--agy-bg-card-primary: #f0f7ff;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #f8fafc);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-input: var(--dsw-alias-bg-layer-1, #ffffff);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #f1f5f9);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #e2e8f0);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #e2e8f0;

	--agy-border-card: var(--dsw-alias-border-l2, #e2e8f0);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #e2e8f0);
	--agy-border-subbox: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-input-focus: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-border-btn: var(--dsw-alias-border-l2, #cbd5e1);
	--agy-border-btn-primary: #2563eb;
	--agy-border-divider: var(--dsw-alias-border-l2, #e2e8f0);

	--agy-text-primary: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #334155);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #64748b);
	--agy-text-muted: var(--dsw-alias-label-caption, #94a3b8);
	--agy-text-btn: var(--dsw-alias-label-primary, #0f172a);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #2563eb;

	--agy-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.05);
	--agy-shadow-card-hover: 0 4px 12px rgba(0, 0, 0, 0.08);
	--agy-shadow-card-primary: 0 0 0 1px #3b82f6, 0 4px 14px rgba(37, 99, 235, 0.12);

	/* Badges */
	--agy-badge-primary-bg: #dbeafe;
	--agy-badge-primary-text: #1e40af;
	--agy-badge-primary-border: #60a5fa;

	--agy-badge-tag-bg: #f1f5f9;
	--agy-badge-tag-text: #334155;
	--agy-badge-tag-border: #cbd5e1;

	--agy-badge-email-bg: #eff6ff;
	--agy-badge-email-text: #1d4ed8;
	--agy-badge-email-border: #bfdbfe;

	--agy-badge-proxy-bg: #ecfdf5;
	--agy-badge-proxy-text: #047857;
	--agy-badge-proxy-border: #a7f3d0;

	--agy-badge-ready-bg: #ecfdf5;
	--agy-badge-ready-text: #047857;
	--agy-badge-ready-border: #a7f3d0;

	--agy-badge-unready-bg: #eff6ff;
	--agy-badge-unready-text: #1d4ed8;
	--agy-badge-unready-border: #bfdbfe;

	/* Quota status pills */
	--agy-quota-high-bg: #ecfdf5;
	--agy-quota-high-text: #047857;
	--agy-quota-high-border: #a7f3d0;
	--agy-quota-med-bg: #fffbeb;
	--agy-quota-med-text: #b45309;
	--agy-quota-med-border: #fde68a;
	--agy-quota-low-bg: #fef2f2;
	--agy-quota-low-text: #b91c1c;
	--agy-quota-low-border: #fecaca;
	--agy-quota-none-bg: #f1f5f9;
	--agy-quota-none-text: #64748b;
	--agy-quota-none-border: #cbd5e1;

	/* Danger button */
	--agy-danger-bg: #fef2f2;
	--agy-danger-text: #b91c1c;
	--agy-danger-border: #fecaca;
	--agy-danger-hover-bg: #fee2e2;

	/* Warning banner */
	--agy-warn-bg: #fffbeb;
	--agy-warn-text: #92400e;
	--agy-warn-border: #fcd34d;
	--agy-warn-btn-bg: #fef3c7;
	--agy-warn-btn-text: #92400e;
	--agy-warn-btn-border: #f59e0b;

	/* Toast notices */
	--agy-toast-success-bg: #ecfdf5;
	--agy-toast-success-text: #065f46;
	--agy-toast-success-border: #6ee7b7;
	--agy-toast-info-bg: #eff6ff;
	--agy-toast-info-text: #1e40af;
	--agy-toast-info-border: #93c5fd;
	--agy-toast-warn-bg: #fffbeb;
	--agy-toast-warn-text: #92400e;
	--agy-toast-warn-border: #fcd34d;
	--agy-toast-error-bg: #fef2f2;
	--agy-toast-error-text: #991b1b;
	--agy-toast-error-border: #fca5a5;

	/* Segment control */
	--agy-seg-group-bg: #e2e8f0;
	--agy-seg-group-border: #cbd5e1;
	--agy-seg-btn-text: #475569;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #dc2626;
	--agy-seg-danger-text: #ffffff;
	--agy-seg-danger-border: #b91c1c;
}

body[data-ds-dark-theme],
body.dark,
[data-theme="dark"] {
	--agy-bg-panel: var(--dsw-alias-bg-layer-2, #0f172a);
	--agy-bg-card: var(--dsw-alias-bg-layer-2, #1e293b);
	--agy-bg-card-primary: #111d33;
	--agy-bg-header: var(--dsw-alias-bg-layer-1, #1e293b);
	--agy-bg-box: var(--dsw-alias-bg-layer-1, #0f172a);
	--agy-bg-subbox: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-input: var(--dsw-alias-bg-layer-3, #090d16);
	--agy-bg-btn: var(--dsw-alias-bg-layer-3, #334155);
	--agy-bg-btn-hover: var(--dsw-alias-interactive-bg-hover, #475569);
	--agy-bg-btn-primary: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-bg-progress-track: #1e293b;

	--agy-border-card: var(--dsw-alias-border-l2, #334155);
	--agy-border-card-primary: #3b82f6;
	--agy-border-box: var(--dsw-alias-border-l1, #1e293b);
	--agy-border-subbox: var(--dsw-alias-border-l2, #334155);
	--agy-border-input: var(--dsw-alias-border-l2, #334155);
	--agy-border-input-focus: #3b82f6;
	--agy-border-btn: var(--dsw-alias-border-l2, #475569);
	--agy-border-btn-primary: #3b82f6;
	--agy-border-divider: var(--dsw-alias-border-l2, #334155);

	--agy-text-primary: var(--dsw-alias-label-primary, #f8fafc);
	--agy-text-secondary: var(--dsw-alias-label-secondary, #cbd5e1);
	--agy-text-tertiary: var(--dsw-alias-label-tertiary, #94a3b8);
	--agy-text-muted: var(--dsw-alias-label-caption, #64748b);
	--agy-text-btn: var(--dsw-alias-label-primary, #ffffff);
	--agy-text-btn-primary: #ffffff;
	--agy-text-window-label: #93c5fd;

	--agy-shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
	--agy-shadow-card-hover: 0 6px 16px rgba(0, 0, 0, 0.4);
	--agy-shadow-card-primary: 0 0 16px rgba(59, 130, 246, 0.25);

	/* Badges */
	--agy-badge-primary-bg: #1e3a8a;
	--agy-badge-primary-text: #93c5fd;
	--agy-badge-primary-border: #3b82f6;

	--agy-badge-tag-bg: #0f172a;
	--agy-badge-tag-text: #cbd5e1;
	--agy-badge-tag-border: #334155;

	--agy-badge-email-bg: #1e293b;
	--agy-badge-email-text: #93c5fd;
	--agy-badge-email-border: #3b82f6;

	--agy-badge-proxy-bg: #064e3b;
	--agy-badge-proxy-text: #6ee7b7;
	--agy-badge-proxy-border: #059669;

	--agy-badge-ready-bg: rgba(16, 185, 129, 0.15);
	--agy-badge-ready-text: #34d399;
	--agy-badge-ready-border: rgba(16, 185, 129, 0.35);

	--agy-badge-unready-bg: rgba(59, 130, 246, 0.15);
	--agy-badge-unready-text: #93c5fd;
	--agy-badge-unready-border: rgba(59, 130, 246, 0.35);

	/* Quota status pills */
	--agy-quota-high-bg: #064e3b;
	--agy-quota-high-text: #6ee7b7;
	--agy-quota-high-border: #059669;
	--agy-quota-med-bg: #451a03;
	--agy-quota-med-text: #fde68a;
	--agy-quota-med-border: #d97706;
	--agy-quota-low-bg: #450a0a;
	--agy-quota-low-text: #fca5a5;
	--agy-quota-low-border: #dc2626;
	--agy-quota-none-bg: #1e293b;
	--agy-quota-none-text: #94a3b8;
	--agy-quota-none-border: #475569;

	/* Danger button */
	--agy-danger-bg: #450a0a;
	--agy-danger-text: #fca5a5;
	--agy-danger-border: #ef4444;
	--agy-danger-hover-bg: #5f1313;

	/* Warning banner */
	--agy-warn-bg: #451a03;
	--agy-warn-text: #fde68a;
	--agy-warn-border: #d97706;
	--agy-warn-btn-bg: #78350f;
	--agy-warn-btn-text: #fde68a;
	--agy-warn-btn-border: #d97706;

	/* Toast notices */
	--agy-toast-success-bg: #064e3b;
	--agy-toast-success-text: #6ee7b7;
	--agy-toast-success-border: #059669;
	--agy-toast-info-bg: #1e3a8a;
	--agy-toast-info-text: #93c5fd;
	--agy-toast-info-border: #3b82f6;
	--agy-toast-warn-bg: #451a03;
	--agy-toast-warn-text: #fde68a;
	--agy-toast-warn-border: #d97706;
	--agy-toast-error-bg: #450a0a;
	--agy-toast-error-text: #fca5a5;
	--agy-toast-error-border: #dc2626;

	/* Segment control */
	--agy-seg-group-bg: #090d16;
	--agy-seg-group-border: #334155;
	--agy-seg-btn-text: #94a3b8;
	--agy-seg-btn-active-bg: var(--dsw-alias-state-business-primary, #2563eb);
	--agy-seg-btn-active-text: #ffffff;
	--agy-seg-danger-bg: #7f1d1d;
	--agy-seg-danger-text: #fca5a5;
	--agy-seg-danger-border: #ef4444;
}

.agy-spinner {
	display: inline-block;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	animation: agy-spin 0.75s linear infinite;
	vertical-align: -2px;
	margin-right: 5px;
}
.agy-pulse-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
}
.agy-card-hover {
	transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}
.agy-card-hover:hover {
	border-color: var(--agy-border-card-primary, #3b82f6) !important;
	box-shadow: var(--agy-shadow-card-hover) !important;
}
.agy-btn {
	transition: all 0.15s ease;
	user-select: none;
}
.agy-btn:hover:not(:disabled) {
	filter: brightness(1.08);
	transform: translateY(-0.5px);
}
.agy-btn:active:not(:disabled) {
	transform: translateY(0.5px);
}
.agy-progress-fill {
	transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
.agy-submodel-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 7px 10px;
	font-size: 11.5px;
	border-radius: 6px;
	background: var(--agy-bg-subbox);
	border: 1px solid var(--agy-border-box);
	margin: 4px 0;
	color: var(--agy-text-primary);
}
`;

const S: Record<string, Record<string, unknown>> = {
	container: {
		lineHeight: 1.5,
		fontSize: '13px',
		fontFamily: 'var(--agy-font-family)',
		color: 'var(--agy-text-primary)',
	},
	headerCard: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '12px 16px',
		background: 'var(--agy-bg-header)',
		border: '1px solid var(--agy-border-card)',
		borderRadius: '10px',
		marginBottom: '12px',
		color: 'var(--agy-text-primary)',
		boxShadow: 'var(--agy-shadow-card)',
	},
	badgePrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-primary-bg)',
		color: 'var(--agy-badge-primary-text)',
		border: '1px solid var(--agy-badge-primary-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	badgeTag: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-tag-bg)',
		color: 'var(--agy-badge-tag-text)',
		border: '1px solid var(--agy-badge-tag-border)',
		padding: '2px 7px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 600,
	},
	badgeReady: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-ready-bg)',
		color: 'var(--agy-badge-ready-text)',
		border: '1px solid var(--agy-badge-ready-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	badgeUnready: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		background: 'var(--agy-badge-unready-bg)',
		color: 'var(--agy-badge-unready-text)',
		border: '1px solid var(--agy-badge-unready-border)',
		padding: '2px 8px',
		borderRadius: '5px',
		fontSize: '11px',
		fontWeight: 700,
	},
	card: {
		background: 'var(--agy-bg-card)',
		border: '1px solid var(--agy-border-card)',
		borderRadius: '10px',
		padding: '14px 16px',
		marginBottom: '12px',
		color: 'var(--agy-text-primary)',
		boxShadow: 'var(--agy-shadow-card)',
	},
	cardPrimary: {
		background: 'var(--agy-bg-card-primary)',
		border: '1.5px solid var(--agy-border-card-primary)',
		borderRadius: '10px',
		padding: '14px 16px',
		marginBottom: '12px',
		boxShadow: 'var(--agy-shadow-card-primary)',
		color: 'var(--agy-text-primary)',
	},
	quotaBox: {
		background: 'var(--agy-bg-box)',
		border: '1px solid var(--agy-border-box)',
		borderRadius: '8px',
		padding: '8px 10px',
		marginTop: '10px',
	},
	progressBarBg: {
		flex: '1',
		height: '8px',
		borderRadius: '4px',
		background: 'var(--agy-bg-progress-track)',
		border: '1px solid var(--agy-border-box)',
		overflow: 'hidden',
		margin: '0 10px',
	},
	btn: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 12px',
		borderRadius: '6px',
		border: '1px solid var(--agy-border-btn)',
		background: 'var(--agy-bg-btn)',
		color: 'var(--agy-text-btn)',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 600,
	},
	btnPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '5px 13px',
		borderRadius: '6px',
		border: '1px solid var(--agy-border-btn-primary)',
		background: 'var(--agy-bg-btn-primary)',
		color: 'var(--agy-text-btn-primary)',
		cursor: 'pointer',
		fontSize: '12px',
		fontWeight: 700,
		boxShadow: '0 2px 6px rgba(37, 99, 235, 0.35)',
	},
	btnDanger: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '6px',
		border: '1px solid var(--agy-danger-border)',
		background: 'var(--agy-danger-bg)',
		color: 'var(--agy-danger-text)',
		cursor: 'pointer',
		fontSize: '11px',
		fontWeight: 600,
	},
	btnSm: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '5px',
		border: '1px solid var(--agy-border-btn)',
		background: 'var(--agy-bg-btn)',
		color: 'var(--agy-text-btn)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 600,
	},
	btnSmPrimary: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '4px 9px',
		borderRadius: '5px',
		border: '1px solid var(--agy-border-btn-primary)',
		background: 'var(--agy-bg-btn-primary)',
		color: 'var(--agy-text-btn-primary)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 700,
	},
	segGroup: {
		display: 'inline-flex',
		background: 'var(--agy-seg-group-bg)',
		borderRadius: '7px',
		padding: '3px',
		border: '1px solid var(--agy-seg-group-border)',
	},
	segBtn: {
		padding: '4px 10px',
		borderRadius: '4px',
		border: 'none',
		background: 'transparent',
		color: 'var(--agy-seg-btn-text)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 600,
	},
	segBtnActive: {
		padding: '4px 10px',
		borderRadius: '4px',
		border: 'none',
		background: 'var(--agy-seg-btn-active-bg)',
		color: 'var(--agy-seg-btn-active-text)',
		cursor: 'pointer',
		fontSize: '11.5px',
		fontWeight: 700,
		boxShadow: '0 2px 4px rgba(37, 99, 235, 0.4)',
	},
	input: {
		flex: '1',
		padding: '7px 12px',
		borderRadius: '6px',
		border: '1.5px solid var(--agy-border-input)',
		background: 'var(--agy-bg-input)',
		color: 'var(--agy-text-primary)',
		fontSize: '12.5px',
		outline: 'none',
	},
	muted: { color: 'var(--agy-text-tertiary)', fontSize: '11.5px' },
	noticeBanner: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '10px 14px',
		borderRadius: '8px',
		marginBottom: '12px',
		fontSize: '12.5px',
		fontWeight: 500,
	},
};

export function apply(ctx: ClientContext): void {
	// locale is declared in inject — cordis guarantees ctx.locale (issue #24).
	const locale = ctx.locale;
	ctx.effect(() => {
		const disposePtBR = locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' });
		const disposeEs = locale.addLanguage({ id: 'es', label: 'Español', fallback: 'en' });
		// Untyped single-locale form: 'agy-link' is not in the host LocaleNamespaceMap merge table.
		const disposeZh = locale.register(NS, 'zh', zh);
		const disposeEn = locale.register(NS, 'en', en);
		const disposePtBRDictionary = locale.register(NS, 'pt-BR', ptBR);
		const disposeEsDictionary = locale.register(NS, 'es', es);
		return () => { disposeEsDictionary(); disposePtBRDictionary(); disposeEn(); disposeZh(); disposeEs(); disposePtBR(); };
	}, 'agy-link: locale dictionaries');
	const useAgyTranslation = () => {
		const [, rerender] = useState(0);
		useEffect(() => locale.subscribe(() => rerender((revision) => revision + 1)), []);
		return locale.bind(NS) as (key: AgyLocaleKey, params?: Record<string, unknown>) => string;
	};
	const AgySettingsSection = (props?: unknown): unknown => {
		const t = useAgyTranslation();
		const { status, refresh } = useAgyStatus();
const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [toast, setToast] = useState<ToastNotice | null>(null);

		// One mount report per mount. The host dispatches this entry with owner
		// props (`provider`, `configured`, `keyConfigured`), so an empty report
		// list on the server proves the host never dispatched the entry at all —
		// the slot registry can be healthy while the directory row that would
		// dispatch it is missing. See `/plugins/agy-link/diagnose`.
		useEffect(() => {
			const names = props !== null && typeof props === 'object' ? Object.keys(props as Record<string, unknown>) : [];
			void postJson('/plugins/agy-link/card-ping', { props: names });
		}, []);

		// Cooldown expiry and quota countdowns are Date.now()-derived while the
		// payload itself does NOT change when they lapse — without a wall-clock
		// tick the "cooldown" banner and the minutes-left froze forever.
		const [, setTimeTick] = useState(0);
		useEffect(() => {
			const timer = setInterval(() => setTimeTick((n) => n + 1), 30_000);
			return () => clearInterval(timer);
		}, []);

		const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => () => {
			// Unmount must not leave a pending timer writing state into a dead
			// component; a second same-text toast also used to be cleared early
			// by the FIRST toast's leftover timer.
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
		}, []);
		const showToast = (text: string, type: ToastNotice['type'] = 'info') => {
			setToast({ text, type, id: Date.now() });
			if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
			toastTimerRef.current = setTimeout(() => {
				toastTimerRef.current = null;
				setToast((prev) => (prev !== null && prev.text === text ? null : prev));
			}, 6000);
		};

		const actionFailed = (): void => {
			showToast(t('api.genericError'), 'error');
		};

		const setCfg = async (key: string, value: unknown): Promise<void> => {
			setLoadingAction(`config:${key}`);
			const res = await postJson('/plugins/agy-link/config', { key, value });
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
		};

		const hiddenPendingRef = useRef<Set<string> | null>(null);
		const toggleModelHidden = async (id: string, hide: boolean): Promise<void> => {
			// Merge against the PENDING set, not the last-rendered snapshot:
			// two rapid clicks used to read the same stale status and the
			// second silently overwrote the first (lost update).
			const next = new Set(hiddenPendingRef.current ?? status?.hiddenModels ?? []);
			if (hide) next.add(id); else next.delete(id);
			hiddenPendingRef.current = next;

			try {
				await setCfg('hiddenModels', Array.from(next));
			} finally {
				if (hiddenPendingRef.current === next) hiddenPendingRef.current = null;
			}
		};

		const refreshQuota = async (): Promise<void> => {
			setLoadingAction('refresh:all');
			const res = await postJson('/plugins/agy-link/pool/refresh-quota', {});
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			await refresh();
			setLoadingAction(null);
			showToast(t('quota.refreshed'), 'success');
		};
		const authPhase = status?.auth?.phase ?? 'unknown';
		const pool = status?.pool;
		const catalogModels = status?.catalogModels ?? [];
		const hiddenModelSet = new Set(status?.hiddenModels ?? []);
		const accounts = pool?.accounts ?? [];
		// `accounts.length > 0` only proves the keyring entry exists, not that the
		// OAuth token behind it still works — the quota RPCs know that, so an
		// expired token must override an otherwise "ready" badge.
		const isAuthed = authPhase !== 'expired' && (authPhase === 'ok' || accounts.length > 0);
		const isBusy = loadingAction !== null;

		const renderSpinner = () => h('span', { className: 'agy-spinner' });

		const renderToastBanner = () => {
			if (!toast) return null;
			const typeStyles = {
				success: { background: 'var(--agy-toast-success-bg)', border: '1px solid var(--agy-toast-success-border)', color: 'var(--agy-toast-success-text)' },
				info: { background: 'var(--agy-toast-info-bg)', border: '1px solid var(--agy-toast-info-border)', color: 'var(--agy-toast-info-text)' },
				warn: { background: 'var(--agy-toast-warn-bg)', border: '1px solid var(--agy-toast-warn-border)', color: 'var(--agy-toast-warn-text)' },
				error: { background: 'var(--agy-toast-error-bg)', border: '1px solid var(--agy-toast-error-border)', color: 'var(--agy-toast-error-text)' },
			};
			const style = typeStyles[toast.type];
			return h('div', { style: { ...S.noticeBanner, ...style } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } },
					uiIcon(toast.type === 'success' ? 'check' : toast.type === 'error' || toast.type === 'warn' ? 'alert' : 'globe', 14, style.color),
					h('span', null, toast.text),
				),
				h('button', {
					type: 'button',
					style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px', opacity: 0.8, display: 'inline-flex', alignItems: 'center' },
					onClick: () => setToast(null),
					'aria-label': t('aria.closeToast'),
				}, uiIcon('x', 12)),
			);
		};

		const renderQuotaBar = (label: string, familyKey: 'google' | 'anthropic' | 'openai', acc: ManagedAccount): unknown => {
			const info = acc.quotas[familyKey];
			const cd = acc.cooldowns[familyKey];
			const inCooldown = cd && cd.cooldownUntil > Date.now();

			// 5-Hour limit
			const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
			const pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
			// Cooldown is a LOCAL heuristic — never overwrite the server-reported
			// fraction with 0% (a ghost cooldown used to show a 98%-full account as
			// empty). Surface it as a note next to the reset time instead.
			const cdNote = inCooldown ? t('account.localCooldown') : '';
			const w5h = formatQuotaWindow(t, info?.resetTime);

			// Weekly limit
			const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
			const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
			const wWeekly = formatQuotaWindow(t, info?.weeklyResetTime);

			const getColors = (pct: number) => {
				if (pct < 0) {
					return {
						bar: 'var(--agy-quota-none-border)',
						text: 'var(--agy-quota-none-text)',
						bg: 'var(--agy-quota-none-bg)',
						border: 'var(--agy-quota-none-border)',
					};
				}
				if (pct <= 20) {
					return {
						bar: 'linear-gradient(90deg, #dc2626, #ef4444)',
						text: 'var(--agy-quota-low-text)',
						bg: 'var(--agy-quota-low-bg)',
						border: 'var(--agy-quota-low-border)',
					};
				}
				if (pct <= 50) {
					return {
						bar: 'linear-gradient(90deg, #d97706, #f59e0b)',
						text: 'var(--agy-quota-med-text)',
						bg: 'var(--agy-quota-med-bg)',
						border: 'var(--agy-quota-med-border)',
					};
				}
				return {
					bar: 'linear-gradient(90deg, #059669, #10b981)',
					text: 'var(--agy-quota-high-text)',
					bg: 'var(--agy-quota-high-bg)',
					border: 'var(--agy-quota-high-border)',
				};
			};

			const c5h = getColors(pct5h);
			const cWeekly = getColors(pctWeekly);

			const renderLine = (windowName: string, percent: number, c: { bar: string; text: string; bg: string; border: string }, resetStr: string) => {
				return h('div', { style: { display: 'flex', alignItems: 'center', fontSize: '11.5px', margin: '4px 0' } },
					h('span', { style: { width: '52px', color: 'var(--agy-text-window-label)', fontSize: '11px', fontWeight: 700, flexShrink: 0 } }, windowName),
					h('div', { style: S.progressBarBg },
						h('div', {
							className: 'agy-progress-fill',
							style: {
								width: `${percent < 0 ? 100 : percent}%`,
								height: '100%',
								background: c.bar,
								borderRadius: '3px',
							},
						}),
					),
					h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', minWidth: '140px', justifyContent: 'flex-end', flexShrink: 0 } },
						h('span', {
							style: {
								padding: '2px 7px',
								borderRadius: '4px',
								background: c.bg,
								color: c.text,
								border: `1px solid ${c.border}`,
								fontWeight: 700,
								fontSize: '11.5px',
								lineHeight: 1.2,
							},
						}, percent < 0 ? '—' : `${percent}%`),
						resetStr ? h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '11px', fontWeight: 500 } }, `↻ ${resetStr}`) : null,
					),
				);
			};

			return h('div', { style: { margin: '6px 0', padding: '8px 10px', background: 'var(--agy-bg-subbox)', borderRadius: '7px', border: '1px solid var(--agy-border-box)' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '12.5px', marginBottom: '5px', color: 'var(--agy-text-primary)' } },
					brandIcon(FAMILY_BRAND[familyKey], 14),
					h('span', null, label),
				),
				renderLine(t('quota.fiveHour'), pct5h, c5h, w5h.resetText ? w5h.resetText + cdNote : cdNote.replace(/^ · /, '')),
				renderLine(t('quota.weekly'), pctWeekly, cWeekly, wWeekly.resetText),
			);
		};

		// Single account, no pool. The status endpoint always returns exactly one
		// account (the keyring identity), so there is no active/primary notion,
		// no per-account proxy override, and nothing to add or remove. The whole
		// multi-account UI (add flow, 设为主用, 代理, 删除, 号池调度, 清除冷却) was
		// wired to /plugins/agy-link/pool/* routes this plugin never registered —
		// every one of those buttons could only ever fail with a generic error.
		// Shapes + restore procedure: docs/archived-panel-ui-20261020.md.
		const account = accounts[0];
		// The keyring OAuth token is refreshed by agy.exe itself; a 401 from the
		// quota RPCs therefore means "credentials lapsed", not "broken panel".
		// Say so instead of rendering an unexplained empty card.
		const quotaExpired = status?.quotaError === 'unauthorized';
		const expiredBanner = quotaExpired
			? h('div', {
				style: {
					background: 'var(--agy-warn-bg)',
					border: '1px solid var(--agy-warn-border)',
					borderRadius: '7px',
					padding: '8px 10px',
					color: 'var(--agy-warn-text)',
					fontSize: '12px',
					fontWeight: 600,
					marginBottom: '10px',
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
				},
			},
				uiIcon('alert', 13, 'var(--agy-warn-text)'),
				h('span', null, t('quota.expiredHint')),
			)
			: null;

		const googleModels = account?.quotas.google?.models ?? [];
		const quotaCard = account
			? h('div', { className: 'agy-card-hover', style: S.card },
				h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
						h('span', {
							className: 'agy-pulse-dot',
							style: { background: '#10b981', boxShadow: '0 0 8px #10b981aa' },
						}),
						// One identity line: the alias the server builds already carries
						// name + email, so the old separate email badge was a repeat.
						h('span', { style: { fontWeight: 700, fontSize: '13.5px', color: 'var(--agy-text-primary)' } }, account.alias || t('quota.accountUnknown')),
					),
					h('div', { style: { display: 'flex', gap: '5px', alignItems: 'center' } },
						h('button', {
							type: 'button',
							className: 'agy-btn',
							style: { ...S.btnSm, gap: '4px' },
							title: t('header.refreshQuota'),
							disabled: isBusy,
							onClick: () => void refreshQuota(),
						}, loadingAction === 'refresh:all' ? [renderSpinner(), t('header.refreshing')] : [uiIcon('refresh', 11), ` ${t('header.refreshQuota')}`]),
					),
				),
				h('div', { style: S.quotaBox },
					renderQuotaBar('Gemini', 'google', account),
					googleModels.length > 0 ? h('div', {
						style: { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--agy-border-box)' },
					},
						h('div', { style: { color: 'var(--agy-text-secondary)', marginBottom: '6px', fontWeight: 600, fontSize: '11px' } }, t('account.models')),
						googleModels.map((model) => {
							const hasFrac = typeof model.remainingFraction === 'number' && Number.isFinite(model.remainingFraction);
							const pct = hasFrac ? Math.max(0, Math.min(100, Math.round((model.remainingFraction as number) * 100))) : -1;
							const w = formatQuotaWindow(t, model.resetTime);
							const pColor = pct < 0 ? 'var(--agy-quota-none-text)' : pct <= 20 ? 'var(--agy-quota-low-text)' : pct <= 50 ? 'var(--agy-quota-med-text)' : 'var(--agy-quota-high-text)';
							return h('div', { key: model.modelId, className: 'agy-submodel-row' },
								h('span', { style: { fontWeight: 500, color: 'var(--agy-text-primary)' } }, model.displayName || model.modelId),
								h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
									h('span', { style: { color: pColor, fontWeight: 700 } }, pct < 0 ? '—' : `${pct}%`),
									w.resetText ? h('span', { style: { color: 'var(--agy-text-tertiary)', fontSize: '10.5px' } }, `↻ ${w.resetText}`) : null,
								),
							);
						}),
					) : null,
				),
			)
			: null;


		if (status === null) {
			return h('div', { style: { ...S.container, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
				h('style', null, GLOBAL_CSS),
				h('span', { style: S.muted }, [renderSpinner(), t('status.loading')]),
			);
		}

		// Credential lifetime, not login-flow state. The keep-alive runs on the
		// host, so the only way to notice it failing is to show the clock the
		// user can watch: green while there is time, amber in the last minutes,
		// red once the credential is gone.
		const tokenSeconds = typeof status?.auth?.tokenExpiresInSeconds === 'number'
			? status.auth.tokenExpiresInSeconds
			: null;
		const keepaliveOn = status?.auth?.keepalive === true;
		// The host now reports why the last renewal attempt gave up. Without this
		// the panel said "renewing…" forever while agy.exe was in fact rejecting
		// our own argv and exiting before it ever touched the credential.
		const renewalReason = typeof status?.auth?.keepaliveLastReason === 'string'
			? status.auth.keepaliveLastReason
			: null;
		const renewalDetail = typeof status?.auth?.keepaliveLastDetail === 'string'
			? status.auth.keepaliveLastDetail
			: null;
		const renewalBroken = renewalReason === 'rejected' || renewalReason === 'failed' || renewalReason === 'not-rotated';
		const tokenLine = (() => {
			if (tokenSeconds === null) return null;
			const expired = tokenSeconds <= 0;
			const warned = !expired && tokenSeconds <= 300;
			// A broken renewal outranks the clock: it is the thing the user has to fix.
			const broken = renewalBroken && (expired || warned);
			const text = expired
				? (broken
					? t('auth.tokenRenewFailed')
					: keepaliveOn ? t('auth.tokenRenewing') : t('auth.tokenExpired'))
				: t('auth.tokenLeft').replace('{minutes}', String(Math.max(1, Math.round(tokenSeconds / 60))));
			return h('span', {
				style: {
					fontSize: '11.5px',
					fontWeight: 600,
					color: expired || broken ? 'var(--agy-warn-text)' : warned ? 'var(--agy-quota-med-text)' : 'var(--agy-text-tertiary)',
				},
				title: renewalDetail === null ? t('auth.tokenHint') : `${t('auth.tokenHint')}\n${renewalReason ?? ''}: ${renewalDetail}`,
			}, `${expired ? '⚠ ' : ''}${text}`);
		})();

		return h('div', { style: S.container },
			h('style', null, GLOBAL_CSS),
			h('div', { style: S.headerCard },
				// No icon + "Antigravity" here: the host Models settings page
				// already names this provider row ("Antigravity CLI"), so the
				// panel body repeating the product name was the duplicate the
				// account card did not need.
				h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
					h('span', { style: isAuthed ? S.badgeReady : S.badgeUnready }, isAuthed ? t('status.ready') : t('status.needsAuth')),
					tokenLine,
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btn, gap: '4px' },
						disabled: isBusy,
						onClick: () => void refreshQuota(),
					}, loadingAction === 'refresh:all' ? [renderSpinner(), t('header.refreshing')] : [uiIcon('refresh', 12, 'var(--agy-text-btn)'), ` ${t('header.refreshQuota')}`]),
				),
			),
			renderToastBanner(),
			expiredBanner,
			quotaCard,
			h('div', { style: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--agy-border-divider)' } },
				h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
					// No 权限模式 row here. It used to offer plan / accept-edits / skip,
					// but the server answers `permissionMode: 'dsh-owned'` as a constant
					// and POST /config has no branch for that key — so no button ever
					// rendered as active and clicking did nothing at all. Permissions
					// belong to the DSH session (docs/dsh-provider-contract.md: the
					// provider never passes --dangerously-skip-permissions), which is
					// why wiring it was not an option either. Shape + restore notes:
					// docs/archived-panel-ui-20261020.md.
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('effort.label')),
						h('div', { style: S.segGroup },
							h('button', {
								type: 'button',
								style: status?.defaultEffort === '' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', ''),
							}, t('effort.auto')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'low' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'low'),
							}, t('effort.low')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'medium' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'medium'),
							}, t('effort.medium')),
							h('button', {
								type: 'button',
								style: status?.defaultEffort === 'high' ? S.segBtnActive : S.segBtn,
								onClick: () => void setCfg('defaultEffort', 'high'),
							}, t('effort.high')),
						),
					),
					h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
						h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('models.label')),
						catalogModels.length === 0
							? h('span', { style: S.muted }, t('models.empty'))
							: h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
								catalogModels.map((m) => {
									const isHidden = hiddenModelSet.has(m.id);
									return h('button', {
										type: 'button',
										key: m.id,
										title: m.id,
										disabled: loadingAction === 'config:hiddenModels',
										style: isHidden ? { ...S.segBtn, opacity: 0.45, textDecoration: 'line-through' } : S.segBtnActive,
										onClick: () => void toggleModelHidden(m.id, !isHidden),
									}, m.name);
								}),
							),
						h('span', { style: S.muted }, t('models.hint')),
					),
				),
			),
		);
	};

	// Antigravity's management surface lives INSIDE the host's Models settings
	// page: the provider row this plugin declares (`settingsNs:
	// 'dsh-agy-provider'` in src/index.ts) is the only entry point. The Models
	// section dispatches `settings.models.provider-card` on every card that
	// renders a directory row with `entryKey = row.entry.settingsNs`, and the
	// slot core renders the entry whose registered `key` equals that entryKey
	// verbatim — so this one key both selects the saved row and its first-run
	// setup card.
	//
	// NO registration in `conversation.session.header.actions` (a chat toolbar
	// badge) and NONE in `settings.section` (a nav entry of its own): the user's
	// directive is that this plugin shows up nowhere except the settings-model
	// page.
	ctx.slots.inject('settings.models.provider-card', () => {
		const dispose = ctx.slots.register(
			{
				name: 'settings.models.provider-card',
				key: 'dsh-agy-provider',
				id: 'agy-link-provider-card',
			},
			AgySettingsSection,
		);
		return dispose;
	});

	// Native tool-card rendering for the agy_tool mirror (DSH >= 0.1.5):
	// the browser conversation UI keys tool cards by wire name; registering
	// `tool.call.toolview` for `agy_tool` makes every mirrored agy step render
	// as a terminal / diff / read / search card instead of a generic text row.
	installAgyToolView(ctx);

	// Keep an opened reasoning body pinned to its newest line while the row
	// runs. The fold itself (one-line "newest step" summary) is the host's,
	// driven by the provider's one-paragraph-per-step text. Installed through
	// ctx.effect so a plugin reload DISCONNECTS the old MutationObserver
	// instead of stacking one observer per reload.
	ctx.effect(() => installReasoningFollow());

	// Draw ```mermaid fences (DSH's shiki pass has no mermaid grammar and
	// leaves them as plain code blocks). Same lifecycle contract as above.
	ctx.effect(() => installMermaidRendering());

	// Local image display + fullscreen lightbox (recovered working tree).
	ctx.effect(() => installImageEnhancer());

	// Interactive user decision & choice chips (recovered working tree).
	ctx.effect(() => installDecisionChips());
}
