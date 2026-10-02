import type { Metadata } from 'next'
import { Playfair_Display, Inter, Poppins } from 'next/font/google'
import { THEME_SCRIPT } from '@/lib/theme'
import './globals.css'

/**
 * Type system lifted from lacessports.com:
 *   Playfair Display 900 — display/headings
 *   Inter              — body copy
 *   Poppins 600        — buttons and eyebrow labels
 */
const playfair = Playfair_Display({
  weight: ['700', '900'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const poppins = Poppins({
  weight: ['500', '600'],
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Mock Draft',
  description:
    'A fantasy football mock draft simulator built on live average draft position.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    // suppressHydrationWarning: the pre-paint script below stamps data-theme
    // onto <html> before React hydrates, so the server and client markup
    // legitimately differ on that attribute.
    <html
      lang="en"
      className={`${playfair.variable} ${inter.variable} ${poppins.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
