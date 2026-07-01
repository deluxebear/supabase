import { useParams } from 'common'
import { useEffect } from 'react'

import { useGitHubAuthorizationCreateMutation } from '@/data/integrations/github-authorization-create-mutation'
import { t as $t } from '@/lib/i18n'

const GitHubIntegrationAuthorize = () => {
  const { code, state, setup_action } = useParams()

  const { mutate, isSuccess, isError, isPending } = useGitHubAuthorizationCreateMutation({
    onSuccess() {
      window.close()
    },
  })

  useEffect(() => {
    if (code && state) {
      mutate({ code, state })
    } else if (setup_action === 'install') {
      window.close()
    }
  }, [code, state, mutate, setup_action])

  return (
    <div className="h-screen flex flex-col justify-center items-center gap-4">
      <h2>{$t('Completing GitHub Authorization...')}</h2>

      {isSuccess && <p>{$t('You can now close this window.')}</p>}
      {isPending && <p>{$t('Authorizing...')}</p>}
      {isError && <p>{$t('Unable to authorize. Please try again.')}</p>}
    </div>
  )
}

export default GitHubIntegrationAuthorize
