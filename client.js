// dsh-mastery — browser half.
//
// Three chips in the composer tool row, immediately left of the model selector
// (`conversation.input.right` sits between `input.plan` and `input.model`). A chip is a
// per-chat switch: it asks the Host to register that bundle's skills into THIS session's
// agent layer, which changes the `<available_skills>` catalog the model receives on its
// next step. Nothing is global and nothing is hidden — the count next to a chip is the
// number of times the model actually pulled a skill body in this chat, and the arrow is how
// many commits the bundle's git source is behind its upstream (the Host checks that; the
// chip only displays it).

window.__ModuleLoader__.load({
  id: 'dsh-mastery',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-mastery'
    const STYLE_ID = 'dsh-mastery-style'

    const CSS = `
.dsh-mst { display: inline-flex; align-items: center; gap: 4px; }
.dsh-mst-chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1;
  cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
.dsh-mst-chip:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-mst-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-mst-chip[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); }
.dsh-mst-chip[aria-pressed="true"] .dsh-mst-dot { background: var(--dsw-alias-brand-primary); }
.dsh-mst-chip:disabled { opacity: 0.55; cursor: default; }
.dsh-mst-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.dsh-mst-count { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); opacity: 0.9; }
.dsh-mst-chip[aria-pressed="true"] .dsh-mst-count { color: var(--dsw-alias-brand-primary); opacity: 1; }
.dsh-mst-behind { font-variant-numeric: tabular-nums; color: var(--dsw-alias-state-warning-primary, #c98100); }
.dsh-mst-warn { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); font-size: 11px; cursor: help; }
`

    /** One call to the Host route; throws the Host's own message on failure. */
    async function request(path, init) {
      const response = await fetch(ROUTE + path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const message =
          payload !== null && payload.error !== undefined && typeof payload.error.message === 'string'
            ? payload.error.message
            : `mastery request failed (${response.status})`
        throw new Error(message)
      }
      return payload.value
    }

    function behindOf(bundle) {
      const update = bundle.update
      if (update === null || update === undefined) return 0
      return typeof update.behind === 'number' && update.behind > 0 ? update.behind : 0
    }

    function chipTitle(bundle) {
      const parts = []
      if (bundle.blurb !== '') parts.push(bundle.blurb)
      if (bundle.skills.length > 0) parts.push(`skills: ${bundle.skills.join(', ')}`)
      if (bundle.error !== undefined && bundle.error !== null) parts.push(bundle.error)
      if (typeof bundle.updateText === 'string' && bundle.updateText !== '') parts.push(`source: ${bundle.updateText}`)
      if (bundle.uses > 0) parts.push(`loaded ${bundle.uses}\u00d7 in this chat`)
      else if (bundle.enabled) parts.push('enabled, not loaded yet')
      parts.push(bundle.enabled ? 'Click to remove from this chat' : 'Click to add to this chat')
      return parts.join('\n')
    }

    function Chip({ bundle, pending, onToggle }) {
      const unavailable = bundle.present === false || bundle.skills.length === 0
      const disabled = pending || unavailable
      const behind = behindOf(bundle)
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-mst-chip',
          'aria-pressed': bundle.enabled ? 'true' : 'false',
          'aria-label': `${bundle.title}: ${bundle.enabled ? 'on' : 'off'} for this chat`,
          title: chipTitle(bundle),
          disabled,
          onClick: () => onToggle(bundle),
        },
        h('span', { className: 'dsh-mst-dot', 'aria-hidden': 'true' }),
        h('span', null, bundle.label),
        behind > 0 ? h('span', { className: 'dsh-mst-behind' }, `\u2191${behind}`) : null,
        bundle.uses > 0 ? h('span', { className: 'dsh-mst-count' }, String(bundle.uses)) : null,
      )
    }

    function Mastery(props) {
      const sessionId = props !== null && props !== undefined ? props.sessionId : undefined
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState('')

      const refresh = React.useCallback(
        async (signal) => {
          if (sessionId === undefined || sessionId === null) return
          try {
            const value = await request(`/state?sessionId=${encodeURIComponent(String(sessionId))}`, { signal })
            setState(value)
            setError('')
          } catch (failure) {
            if (failure !== null && failure !== undefined && failure.name === 'AbortError') return
            setError(failure !== null && failure !== undefined && failure.message ? failure.message : String(failure))
          }
        },
        [sessionId],
      )

      React.useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        return () => controller.abort()
      }, [refresh])

      // The count is evidence, so it must catch up while the turn runs.
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void refresh()
        }, 5000)
        return () => clearInterval(timer)
      }, [refresh, sessionId])

      const toggle = React.useCallback(
        async (bundle) => {
          if (sessionId === undefined || sessionId === null || pending !== '') return
          setPending(bundle.id)
          try {
            const value = await request('/toggle', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: String(sessionId), bundleId: bundle.id, enabled: !bundle.enabled }),
            })
            setState(value)
            setError('')
          } catch (failure) {
            setError(failure !== null && failure !== undefined && failure.message ? failure.message : String(failure))
          } finally {
            setPending('')
          }
        },
        [pending, sessionId],
      )

      if (sessionId === undefined || sessionId === null) return null

      const bundles = state !== null && Array.isArray(state.bundles) ? state.bundles : []
      if (bundles.length === 0) {
        if (error === '') return null
        return h('span', { className: 'dsh-mst' }, h('span', { className: 'dsh-mst-warn', title: error }, 'skills!'))
      }

      const children = bundles.map((bundle) =>
        h(Chip, { key: bundle.id, bundle, pending: pending === bundle.id, onToggle: toggle }),
      )
      if (error !== '') {
        children.push(h('span', { key: 'error', className: 'dsh-mst-warn', title: error }, '!'))
      }
      return h('div', { className: 'dsh-mst', role: 'group', 'aria-label': 'Skill bundles for this chat' }, children)
    }

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-mastery'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        installStyles()
        const slots = ctx.get('slots')
        const disposers = []
        disposers.push(
          slots.inject('conversation.input.right', () =>
            slots.register(
              {
                name: 'conversation.input.right',
                id: 'dsh-mastery',
                order: 10,
                label: () => 'Mastery',
              },
              Mastery,
            ),
          ),
        )
        ctx.effect(
          () => () => {
            for (const dispose of disposers.splice(0)) dispose()
          },
          'dsh-mastery: composer chips',
        )
      },
    }
  },
})
