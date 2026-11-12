import { createElement } from 'react'
import { clientRuntime } from '../adapters/client-runtime.js'
import { DOCS_SITE_URL } from '../shared/constants.js'

const h = createElement

/**
 * Documentation entry card for the bundle-level plugin settings page.
 *
 * Rendered above the config list so that "Plugins → dsh-session-grove" opens
 * with an obvious link to the illustrated guide; no host primitives are used,
 * so the component stays testable under the Node React stub.
 */
export const DocsCard = () => {
  const t = clientRuntime()?.t ?? ((key) => key)
  const direction = clientRuntime()?.direction === 'rtl' ? 'rtl' : 'ltr'
  return h(
    'div',
    { class: 'dsg-settings-docs', 'data-testid': 'session-groups-settings-docs', dir: direction },
    h(
      'div',
      { class: 'dsg-settings-docs-copy' },
      h('div', { class: 'dsg-settings-docs-title' }, t('docs.title')),
      h('div', { class: 'dsg-settings-docs-body' }, t('docs.body'))
    ),
    h(
      'a',
      {
        class: 'dsg-settings-docs-link',
        'data-testid': 'session-groups-settings-docs-link',
        href: DOCS_SITE_URL,
        target: '_blank',
        rel: 'noreferrer noopener',
      },
      t('docs.open')
    )
  )
}
