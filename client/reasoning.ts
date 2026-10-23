// Client-side reasoning presentation (dsh-agy-link).
//
// DSH web renders assistant reasoning as <div data-variant="think"> rows,
// default collapsed. We must NOT rewrite React-managed thinkBody DOM:
// clearing textContent destroys host-owned nodes and the block goes blank
// after the turn finishes and React re-renders from the message model.
//
// The "show only the newest step, with a scrolling feel" behavior is NOT
// implemented here. It is the host's own, driven by paragraph structure:
// ReasoningRow's collapsed summary is `latestCompletedParagraphFirstLine`
// while the row runs (first line of the newest completed paragraph) and
// `firstLine` once it settles. The provider therefore emits one
// blank-line-separated paragraph per step, opening with a `[agy 过程流]`
// banner — the fold live-rolls to the newest step with zero client work,
// and settles on the banner.
//
// What this file still owns:
// - CSS-only styling of the think body (scrollable, no DOM surgery).
// - While a row is running AND the reader has opened it, keep the body
//   pinned to the newest line (scrollTop = scrollHeight, `tail -f`).
//   It never opens a row by itself: forcing it open would defeat the
//   one-line fold the user asked for.
//
// Running is read from the host's own `data-state="running"` on the row
// root (the official carrier — no spinner/class guessing), and the row is
// never identified by `[data-message-id]`-style attributes the host does
// not emit.

const REASONING_CSS = `
/* Hover affordance on thinking disclosure rows */
div[data-variant="think"] [data-disclosure-row]:hover [class*="iconIdle"],
div[data-variant="think"] [class*="row"]:hover [class*="iconIdle"] {
	opacity: 0 !important;
}
div[data-variant="think"] [data-disclosure-row]:hover [class*="chevronHover"],
div[data-variant="think"] [class*="row"]:hover [class*="chevronHover"] {
	opacity: 1 !important;
}

/* Scrollable thinking body (does not touch DOM structure) */
div[data-variant="think"] [class*="thinkBody"] {
	max-height: 360px;
	overflow-y: auto;
	overflow-x: hidden;
	white-space: pre-wrap;
	word-break: break-word;
	padding-right: 8px;
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
	background-clip: padding-box;
}
div[data-variant="think"] [class*="thinkBody"]::-webkit-scrollbar-track {
	background: transparent;
	margin: 4px 0;
}
`;

function injectStyles(): void {
	if (typeof document === 'undefined') return
	const styleId = 'dsh-agy-link-reasoning-css'
	if (document.getElementById(styleId) === null) {
		const st = document.createElement('style')
		st.id = styleId
		st.textContent = REASONING_CSS
		const host = document.head ?? document.documentElement
		if (host) host.appendChild(st)
	}
}

function thinkBodyOf(root: HTMLElement): HTMLElement | null {
	return root.querySelector<HTMLElement>('[class*="thinkBody"]')
}

/**
 * One auto pass: every running think row whose body the reader has opened
 * gets pinned to its newest line. A collapsed row has no thinkBody mounted
 * (the host mounts it only when expanded), so the lookup itself is the
 * "did the reader open it" test — no click synthesis, no per-row bookkeeping.
 *
 * The pin only fires when the reader is already at the bottom, so scrolling
 * up to re-read an earlier step is never yanked back down.
 */
function followRunningReasoning(): void {
	if (typeof document === 'undefined') return
	const rows = document.querySelectorAll<HTMLElement>('div[data-variant="think"]')
	for (let i = 0; i < rows.length; i++) {
		const root = rows[i]
		if (!root) continue
		if (root.getAttribute('data-state') !== 'running') continue
		const body = thinkBodyOf(root)
		if (body === null) continue
		if (body.scrollTop + body.clientHeight < body.scrollHeight - 24) continue
		body.scrollTop = body.scrollHeight
	}
}

// Streaming conversations mutate the DOM at high frequency: coalesce
// mutation bursts into one scan pass (mirrors the mermaid scanner's debounce).
let scanTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScan(): void {
	if (scanTimer !== null) return
	scanTimer = setTimeout(() => {
		scanTimer = null
		followRunningReasoning()
	}, 200)
}

let activeObserver: MutationObserver | null = null
let domContentLoadedHandler: (() => void) | null = null

/**
 * Install the reasoning follow-along overlay. Returns a disposer that
 * disconnects the MutationObserver — wrap it in ctx.effect so a plugin
 * reload cannot stack observers.
 */
export function installReasoningFollow(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
	disposeReasoningFollow()
	injectStyles()
	const observer = new MutationObserver(() => {
		scheduleScan()
	})
	activeObserver = observer
	const setupObserver = () => {
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true })
			followRunningReasoning()
		}
	}
	if (document.readyState === 'loading') {
		domContentLoadedHandler = setupObserver
		window.addEventListener('DOMContentLoaded', setupObserver, { once: true })
	} else {
		setupObserver()
	}
	return disposeReasoningFollow
}

/** Disconnect the observer and cancel pending work. */
export function disposeReasoningFollow(): void {
	if (activeObserver !== null) {
		activeObserver.disconnect()
		activeObserver = null
	}
	if (domContentLoadedHandler !== null) {
		window.removeEventListener('DOMContentLoaded', domContentLoadedHandler)
		domContentLoadedHandler = null
	}
	if (scanTimer !== null) {
		clearTimeout(scanTimer)
		scanTimer = null
	}
}
