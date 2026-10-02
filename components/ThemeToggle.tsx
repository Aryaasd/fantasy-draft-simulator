'use client'

import { useEffect, useRef, useState } from 'react'
import { applyTheme, readTheme, resolvedTheme, type Theme } from '@/lib/theme'

const NEXT: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const LABEL: Record<Theme, string> = {
  system: 'Theme: following your system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

function Icon({ theme }: { theme: Theme }) {
  if (theme === 'system') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="2.5"
          y="4"
          width="19"
          height="13"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path d="M8 20.5h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  if (theme === 'light') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Cycles system → light → dark.
 *
 * Renders a stable placeholder until mounted: the server can't know the stored
 * preference, so rendering the real icon on the server would guarantee a
 * hydration mismatch. The pre-paint script in the layout has already applied
 * the correct colors by this point — only the icon waits.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')
  const [mounted, setMounted] = useState(false)
  /**
   * Mirrors `theme` so a rapid second click doesn't recompute from a stale
   * closure. Two clicks inside one React batch would otherwise both read the
   * pre-batch value and apply the same transition twice, so the cycle sticks
   * instead of advancing.
   */
  const current = useRef<Theme>('system')

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const stored = readTheme()
    current.current = stored
    setTheme(stored)
    setMounted(true)
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  function cycle() {
    const next = NEXT[current.current]
    current.current = next
    setTheme(next)
    applyTheme(next)
  }

  const hint = mounted && theme === 'system' ? ` (${resolvedTheme(theme)})` : ''

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={mounted ? `${LABEL[theme]}${hint}. Change theme.` : 'Change theme'}
      title={mounted ? `${LABEL[theme]}${hint}` : undefined}
      suppressHydrationWarning
    >
      {mounted ? <Icon theme={theme} /> : <span style={{ width: 15, height: 15 }} />}
    </button>
  )
}
