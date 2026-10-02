export type Theme = 'light' | 'dark' | 'system'

export const THEME_KEY = 'laces_theme'

/**
 * Runs before first paint, inlined into <head>.
 *
 * Without this there's a flash of light theme on every navigation for anyone
 * on dark — the server can't know the preference, so the page paints light and
 * only corrects once React hydrates. Reading localStorage synchronously here
 * and stamping data-theme fixes it.
 *
 * Deliberately tiny and dependency-free: it blocks rendering, and it must not
 * throw in private-browsing modes where localStorage access can fail.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`

export function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* preference just won't persist */
  }
}

/** What the user would actually see right now, resolving 'system'. */
export function resolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
