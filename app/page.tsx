import { MockDraft } from '@/components/MockDraft'
import { Shell } from '@/components/Shell'
import { DEFAULT_ROUNDS, DEFAULT_SCORING, DEFAULT_SLOTS, DEFAULT_TEAMS } from '@/lib/league'

export const dynamic = 'force-dynamic'

export default function Home() {
  return (
    <Shell>
      <MockDraft
        memberName="You"
        teams={DEFAULT_TEAMS}
        rounds={DEFAULT_ROUNDS}
        slots={DEFAULT_SLOTS}
        scoring={DEFAULT_SCORING}
        initialPosition={1}
      />
    </Shell>
  )
}
