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

// ---- dispatch reporting (Models page card) ----
// The host renders `settings.models.provider-card` only for the directory row
// whose `settingsNs` equals the key registered here, and it wraps every entry in
// an error boundary that renders an EMPTY element when the card throws. So "the
// host never dispatched this card" and "the card crashed on first render" are
// the same pixels, from both sides. Reporting the dispatch itself — from inside
// the render body, see the call site — is what tells them apart at
// `/plugins/agy-link/diagnose`. Throttled so re-renders (and StrictMode's double
// render) cannot flood the endpoint.
let lastDispatchReport = 0;
function reportCardDispatch(props?: unknown): void {
	const now = Date.now();
	if (now - lastDispatchReport < 5_000) return;
	lastDispatchReport = now;
	const names = props !== null && typeof props === 'object' ? Object.keys(props as Record<string, unknown>) : [];
	void postJson('/plugins/agy-link/card-ping', { props: names });
}

// ---- shared status load (no polling) ----
// ONE module-level fetch serves every mounted consumer (the provider card in
// the host's Models settings page). There is deliberately no timer: nothing on
// screen needs a background refresh. The server answers `/status` by spawning
// PowerShell (`execFileSync`) to read the Windows keyring, so any poll
// competes with every other RPC and is the reason the page used to feel stuck.
// The card fetches once per mount (opening the Models page), the local 30 s
// tick below only redraws the countdown, and the refresh button fetches again.
const statusListeners = new Set<(s: StatusPayload) => void>();
let statusFetchSeq = 0;
// Mount fetch and the refresh button overlap freely (a stuck request used to
// let several more start), so entering this gate twice is the bug. A caller that
// arrives while a fetch is running gets the running promise back instead of
// `undefined`: returning early made the caller's `await` resolve instantly, so
// the panel decided the load was over ("failed") while it was still in flight.
let statusInFlight: Promise<void> | null = null;

function notifyStatus(st: StatusPayload): void {
	statusCache = st;
	for (const fn of [...statusListeners]) {
		try { fn(st); } catch { /* a dead consumer must not kill the load */ }
	}
}

async function loadStatusOnce(): Promise<void> {
	if (statusInFlight !== null) return statusInFlight;
	const seq = ++statusFetchSeq;
	const run = (async (): Promise<void> => {
		try {
			const st = await getStatus();
			// A slow response from an older fetch must never overwrite newer data.
			if (st !== null && seq === statusFetchSeq) notifyStatus(st);
		} finally {
			if (statusInFlight === run) statusInFlight = null;
		}
	})();
	statusInFlight = run;
	return run;
}

/**
 * Subscribe a component to the shared status poll. Returns the latest
 * snapshot plus a manual refresh that keeps the last good snapshot on a
 * transient failure (a failed refresh used to flip the whole panel back to
 * its loading state).
 */
/**
 * Subscribe a component to the shared status snapshot. Each mount triggers one
 * fetch (that is what "opening the panel" means), the returned refresh is the
 * button. A transient failure keeps the last good snapshot instead of flipping
 * the whole panel back to its loading state.
 */
function useAgyStatus(): { status: StatusPayload | null; loading: boolean; refresh: () => Promise<void> } {
	const [status, setStatus] = useState<StatusPayload | null>(statusCache);
	const [loading, setLoading] = useState<boolean>(statusCache === null);
	useEffect(() => {
		statusListeners.add(setStatus);
		void loadStatusOnce().then(() => { setLoading(false); });
		return () => {
			statusListeners.delete(setStatus);
		};
	}, []);
	const refresh = async (): Promise<void> => { await loadStatusOnce(); };
	return { status, loading, refresh };
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
.agy-select {
	appearance: none;
	-webkit-appearance: none;
	font: inherit;
	font-size: 11.5px;
	font-weight: 600;
	color: var(--agy-text-primary);
	background-color: var(--agy-bg-subbox);
	border: 1px solid var(--agy-border-box);
	border-radius: 6px;
	padding: 4px 20px 4px 8px;
	max-width: 190px;
	cursor: pointer;
	background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
	background-position: calc(100% - 11px) calc(50% + 1px), calc(100% - 7px) calc(50% + 1px);
	background-size: 4px 4px, 4px 4px;
	background-repeat: no-repeat;
}
.agy-select:hover:not(:disabled) {
	border-color: var(--agy-border-box);
	filter: brightness(1.05);
}
.agy-select:disabled {
	opacity: 0.55;
	cursor: default;
}
.agy-checklist {
	display: flex;
	flex-wrap: wrap;
	gap: 3px 14px;
	max-height: 112px;
	overflow-y: auto;
	padding: 6px 8px;
	border-radius: 6px;
	background: var(--agy-bg-subbox);
	border: 1px solid var(--agy-border-box);
}
.agy-check-item {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 11.5px;
	color: var(--agy-text-primary);
	cursor: pointer;
	white-space: nowrap;
}
.agy-check-item input {
	cursor: pointer;
	margin: 0;
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
		// Reported during render, not from an effect, and deliberately so: the
		// host wraps every slot entry in an error boundary that renders an EMPTY
		// element on a throw (`SlotErrorBoundary` → a bare anchor div). A card
		// that crashes on its first render therefore looks exactly like a card
		// the host never dispatched — an effect would never run in the crashing
		// case, which is the case worth distinguishing. Reporting at the top of
		// the body survives both; `reportCardDispatch` de-duplicates re-renders
		// and StrictMode's double render. See `/plugins/agy-link/diagnose`.
		reportCardDispatch(props);
		const t = useAgyTranslation();
		const { status, loading, refresh } = useAgyStatus();
		const [loadingAction, setLoadingAction] = useState<string | null>(null);
		const [toast, setToast] = useState<ToastNotice | null>(null);

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
			// Only a click that came after this call started is worth fetching.
			const seq = ++statusFetchSeq;
			const res = await postJson('/plugins/agy-link/pool/refresh-quota', {});
			if (res === null || res?.ok === false) {
				setLoadingAction(null);
				actionFailed();
				return;
			}
			// The RPC already answered with the freshly fetched pool, so adopt it
			// (the click owns the sequence number; a concurrent mount fetch is
			// discarded) instead of asking `/status` again — that second round trip
			// re-reads the keyring and refetches the quotas just sent, and it is the
			// slow one the user feels. `/status` is still asked for everything the
			// pool does not carry (auth phase, catalog, overrides).
			const pool = (res as any)?.pool as StatusPayload['pool'] | undefined;
			if (pool !== undefined && pool !== null && statusCache !== null) {
				statusCache = { ...statusCache, pool };
				for (const fn of [...statusListeners]) {
					try { fn(statusCache); } catch { /* a dead consumer must not kill the load */ }
				}
			}
			const st = await getStatus();
			if (st !== null && seq === statusFetchSeq) notifyStatus(st);
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
					h('span', {
						style: {
							color: 'var(--agy-text-window-label)',
							fontSize: '11px',
							fontWeight: 700,
							flexShrink: 0,
							// "5 小时额度" wrapped onto two lines inside the fixed
							// 52px column and pushed the bar off-centre; the label
							// sizes itself and never breaks mid-word now.
							whiteSpace: 'nowrap',
							paddingRight: '6px',
						},
					}, windowName),
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
				// No identity header and no second refresh button here: the status
				// line above already carries account, state, clock and refresh, so
				// this card is quota data only.
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
			// While the first `/status` is still running there is nothing to draw
			// yet; once it has answered (or failed) an empty snapshot must not
			// masquerade as "loading" forever. A failed load gets an actual retry
			// button — the old copy told the user to retry while offering nothing
			// to press, so the second open looked like a blank card.
			return h('div', { style: { ...S.container, minHeight: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' } },
				h('style', null, GLOBAL_CSS),
				loading
					? h('span', { style: S.muted }, [renderSpinner(), t('status.loading')])
					: [
						h('span', { key: 'msg', style: S.muted }, t('api.genericError')),
						h('button', {
							key: 'retry',
							type: 'button',
							style: S.btn,
							onClick: () => { setLoading(true); void loadStatusOnce().then(() => { setLoading(false); }); },
						}, t('status.retry')),
					],
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

		// One status line, not three stacked blocks. The host Models page already
		// prints the provider title ("Antigravity CLI") directly above this card,
		// so the identity + credential clock + readiness all live on the line but
		// one: account → state → "goes stale in N minutes" → refresh. Everything
		// below this line is quota data only.
		const accountAlias = account?.alias?.trim() ? account.alias : t('quota.accountUnknown');

		// --- Collapse model -----------------------------------------------------
		// The host renders this card as a sibling of the provider editor and only
		// mounts that editor while the row is expanded (app.asar ModelsSection:
		// `renderSlot('settings.models.provider-card', {…})`, then
		// `open ? renderProviderEditor(…) : null`). The slot props carry no
		// "expanded" flag, so the editor's presence in the DOM is the only signal
		// available — and mirroring it is what makes 编辑 behave as the toggle for
		// this card too: expanding the row opens the panel, collapsing it closes
		// the panel. `manualOpen` lets the chevron override until the host state
		// changes again.
		const cardRef = useRef<HTMLDivElement | null>(null);
		const [hostOpen, setHostOpen] = useState<boolean | null>(null);
		const [manualOpen, setManualOpen] = useState<boolean | null>(null);
		useEffect(() => {
			const root = cardRef.current;
			if (root === null) return;
			const row = root.closest('li');
			const parent = root.parentElement;
			// Walk to the element whose NEXT sibling is the editor: our own root
			// when the slot renders it inline, otherwise the wrapper the slot core
			// put around it.
			const anchor = parent !== null && parent !== row ? parent : root;
			let previous: boolean | null = null;
			const probe = () => {
				const open = anchor.nextElementSibling !== null;
				if (open === previous) return;
				previous = open;
				setHostOpen(open);
				setManualOpen(null);
			};
			probe();
			const observer = new MutationObserver(probe);
			observer.observe(row ?? (parent ?? root), { childList: true });
			return () => observer.disconnect();
		}, []);
		const expanded = manualOpen ?? hostOpen ?? true;

		// --- Side-by-side fields ------------------------------------------------
		// Model and effort are "how the next turn runs". Both used to be pill
		// clouds with one button per option, so opening up another model family
		// (Pro, etc.) turned this block into a wall of pills that said nothing
		// about which one was actually in effect. Two native selects stay one line
		// tall for any catalog size; visibility is a scrollable checklist.
		const defaultModelId = status?.defaultModel ?? '';
		const defaultEffortId = status?.defaultEffort ?? '';
		const catalogModelIds = new Set(catalogModels.map((m) => m.id));
		const modelSelect = h('select', {
			className: 'agy-select',
			value: defaultModelId,
			disabled: loadingAction === 'config:defaultModel' || catalogModels.length === 0,
			title: defaultModelId,
			onChange: (event: any) => void setCfg('defaultModel', String(event?.target?.value ?? '')),
		}, [
			// Keep the configured model selectable even when the catalog snapshot
			// has not caught up (fresh login, empty quota answer): without this the
			// select would silently display the first catalog entry instead.
			defaultModelId !== '' && !catalogModelIds.has(defaultModelId)
				? h('option', { key: '__current', value: defaultModelId }, defaultModelId)
				: null,
			catalogModels.length === 0
				? h('option', { key: '__empty', value: defaultModelId }, defaultModelId === '' ? t('models.empty') : defaultModelId)
				: null,
			catalogModels.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
		]);
		const effortSelect = h('select', {
			className: 'agy-select',
			value: defaultEffortId,
			disabled: loadingAction === 'config:defaultEffort',
			onChange: (event: any) => void setCfg('defaultEffort', String(event?.target?.value ?? '')),
		}, [
			h('option', { key: 'auto', value: '' }, t('effort.auto')),
			h('option', { key: 'low', value: 'low' }, t('effort.low')),
			h('option', { key: 'medium', value: 'medium' }, t('effort.medium')),
			h('option', { key: 'high', value: 'high' }, t('effort.high')),
		]);
		const visibilityList = catalogModels.length === 0
			? h('span', { style: S.muted }, t('models.empty'))
			: h('div', { className: 'agy-checklist' },
				catalogModels.map((m) => h('label', { key: m.id, className: 'agy-check-item', title: m.id },
					h('input', {
						type: 'checkbox',
						checked: !hiddenModelSet.has(m.id),
						disabled: loadingAction === 'config:hiddenModels',
						onChange: () => void toggleModelHidden(m.id, !hiddenModelSet.has(m.id)),
					}),
					h('span', null, m.name),
				)),
			);
		const settingsBlock = h('div', { style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--agy-border-divider)' } },
			h('div', { style: { display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' } },
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
					h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px', flexShrink: 0 } }, t('models.default')),
					modelSelect,
				),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
					h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('effort.label')),
					effortSelect,
				),
			),
			h('div', { style: { marginTop: '10px' } },
				h('span', {
					style: { display: 'block', color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px', marginBottom: '6px', cursor: 'help' },
					title: t('models.hint'),
				}, t('models.label')),
				visibilityList,
			),
		);

		return h('div', { ref: cardRef, style: S.container },
			h('style', null, GLOBAL_CSS),
			h('div', { style: S.headerCard },
				h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
					h('span', { style: { fontWeight: 700, fontSize: '13.5px', color: 'var(--agy-text-primary)' }, title: accountAlias }, accountAlias),
					h('span', { style: isAuthed ? S.badgeReady : S.badgeUnready }, isAuthed ? t('status.ready') : t('status.needsAuth')),
					tokenLine,
				),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btn, padding: '4px 7px', gap: '0', minWidth: '24px', justifyContent: 'center' },
						title: expanded ? t('panel.collapse') : t('panel.expand'),
						'aria-expanded': expanded ? 'true' : 'false',
						onClick: () => setManualOpen(!expanded),
					}, expanded ? '▾' : '▸'),
					h('button', {
						type: 'button',
						className: 'agy-btn',
						style: { ...S.btn, gap: '4px', flexShrink: 0 },
						disabled: isBusy,
						onClick: () => void refreshQuota(),
					}, loadingAction === 'refresh:all' ? [renderSpinner(), t('header.refreshing')] : [uiIcon('refresh', 12, 'var(--agy-text-btn)'), ` ${t('header.refreshQuota')}`]),
				),
			),
			renderToastBanner(),
			expanded
				? h('div', { style: { display: 'contents' } }, expiredBanner, quotaCard, settingsBlock)
				: null,
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
