import { useRouter } from 'next/router'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { LogoLoader } from 'ui'

import { useSignOut } from '@/lib/auth'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const LogoutPage: NextPageWithLayout = () => {
  const router = useRouter()
  const signOut = useSignOut()

  useEffect(() => {
    const logout = async () => {
      await signOut()
      toast($t('Successfully logged out'))
      await router.push('/sign-in')
    }
    logout()
  }, [])

  return (
    <div className="w-full h-screen flex items-center justify-center">
      <LogoLoader />
    </div>
  )
}

export default LogoutPage
