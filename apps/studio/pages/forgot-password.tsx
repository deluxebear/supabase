import Link from 'next/link'

import { ForgotPasswordWizard } from '@/components/interfaces/SignIn/ForgotPasswordWizard'
import { ForgotPasswordLayout } from '@/components/layouts/SignInLayout/ForgotPasswordLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ForgotPasswordPage: NextPageWithLayout = () => {
  return (
    <>
      <div className="flex flex-col gap-4">
        <ForgotPasswordWizard />
      </div>

      <div className="my-8 self-center text-sm">
        <span className="text-foreground-light">{$t('Already have an account?')}</span>{' '}
        <Link href="/sign-in" className="underline hover:text-foreground-light">
          {$t('Sign In')}
        </Link>
      </div>
    </>
  )
}

ForgotPasswordPage.getLayout = (page) => (
  <ForgotPasswordLayout
    heading="Forgot your password?"
    subheading="Enter your email and we'll send you a code to reset the password"
  >
    {page}
  </ForgotPasswordLayout>
)

export default ForgotPasswordPage
