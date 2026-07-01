import HCaptcha from '@hcaptcha/react-hcaptcha'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRef, useState } from 'react'
import { SubmitHandler, useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Button, DialogFooter, DialogSection, Form, FormControl, FormField, Input } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import * as z from 'zod'

import { InlineLink } from '@/components/ui/InlineLink'
import { useEmailUpdateMutation } from '@/data/profile/profile-update-email-mutation'
import { t as $t } from '@/lib/i18n'

export const GitHubChangeEmailAddress = () => {
  return (
    <DialogSection className="flex flex-col gap-y-2">
      <p className="text-sm">
        {$t('Email addresses for GitHub identities should be updated through GitHub')}
      </p>
      <ol className="flex flex-col gap-y-0.5 text-sm ml-4 pl-2 list-decimal text-foreground-light">
        <li>{$t('Log out of Supabase')}</li>
        <li>
          {$t('Change your Primary Email in')}{' '}
          <InlineLink href="https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/changing-your-primary-email-address">
            {$t('GitHub')}
          </InlineLink>{' '}
          {$t('(your primary email)')}
        </li>
        <li>{$t('Log out of GitHub')}</li>
        <li>{$t('Log back into GitHub (with the new, desired email set as primary)')}</li>
        <li>{$t('Log back into Supabase')}</li>
      </ol>
    </DialogSection>
  )
}

export const SSOChangeEmailAddress = () => {
  return (
    <DialogSection className="flex flex-col gap-y-2">
      <p className="text-sm">
        {$t('Email addresses for SSO should be updated through your identity provider')}
      </p>
      <ol className="flex flex-col gap-y-0.5 text-sm ml-4 pl-2 list-decimal text-foreground-light">
        <li>{$t('Contact the owner / admin for your team to change your email')}</li>
      </ol>
    </DialogSection>
  )
}

export const ChangeEmailAddressForm = ({ onClose }: { onClose: () => void }) => {
  const captchaRef = useRef<HCaptcha>(null)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)

  const FormSchema = z.object({ email: z.string().email() })
  const form = useForm<z.infer<typeof FormSchema>>({
    mode: 'onBlur',
    reValidateMode: 'onBlur',
    resolver: zodResolver(FormSchema),
    defaultValues: { email: '' },
  })

  const { mutate: updateEmail, isPending } = useEmailUpdateMutation({
    onSuccess: (_, vars) => {
      toast.success(
        `A confirmation email has been sent to ${vars.email}. Please confirm the change within 10 minutes.`
      )
      onClose()
    },
    onError: (error) => {
      toast.error(`Failed to update email: ${error.message}`)
      setCaptchaToken(null)
      captchaRef.current?.resetCaptcha()
    },
  })

  const onSubmit: SubmitHandler<z.infer<typeof FormSchema>> = async (values) => {
    let token = captchaToken
    if (!token) {
      const captchaResponse = await captchaRef.current?.execute({ async: true })
      token = captchaResponse?.response ?? null
    }

    updateEmail({ email: values.email, hcaptchaToken: token ?? null })
  }

  return (
    <Form {...form}>
      <form id="update-email-form" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="self-center">
          <HCaptcha
            ref={captchaRef}
            sitekey={process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY!}
            size="invisible"
            onVerify={(token) => setCaptchaToken(token)}
            onExpire={() => setCaptchaToken(null)}
          />
        </div>

        <DialogSection>
          <FormField
            name="email"
            control={form.control}
            render={({ field }) => (
              <FormItemLayout
                label={$t('Provide a new email address')}
                description={$t('A confirmation email will be sent to the provided email address')}
              >
                <FormControl>
                  <Input {...field} placeholder="example@email.com" />
                </FormControl>
              </FormItemLayout>
            )}
          />
        </DialogSection>

        <DialogFooter>
          <Button variant="default" disabled={isPending} onClick={onClose}>
            {$t('Cancel')}
          </Button>
          <Button type="submit" loading={isPending} disabled={isPending}>
            {$t('Confirm')}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
