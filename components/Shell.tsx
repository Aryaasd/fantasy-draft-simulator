'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from '@/components/ThemeToggle'

/** Two surfaces, so the nav stays a nav rather than becoming a menu. */
const TABS = [
  { href: '/', label: 'Mock draft' },
  { href: '/plan', label: 'Draft plan' },
]

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname()

  return (
    <>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <Link href="/" className="nav-brand">
            <span className="nav-wordmark">mock draft</span>
          </Link>
          <ul className="nav-links">
            {TABS.map((t) => (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={`nav-link${path === t.href ? ' active' : ''}`}
                  aria-current={path === t.href ? 'page' : undefined}
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="nav-right">
            <ThemeToggle />
          </div>
        </div>
      </nav>
      <main className="shell" style={{ maxWidth: 900 }}>
        {children}
      </main>
    </>
  )
}
