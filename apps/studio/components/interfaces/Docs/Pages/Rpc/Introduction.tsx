import { DocSection } from '../../DocSection'
import { t as $t } from '@/lib/i18n'

const Introduction = () => {
  return (
    <DocSection
      title={$t('Introduction')}
      content={
        <>
          <p>
            {$t(
              "All of your database functions are available on your API. This means you can build your logic directly into the database (if you're brave enough)!"
            )}
          </p>
          <p>
            {$t('The API endpoint supports POST (and in some cases GET) to execute the function.')}
          </p>
        </>
      }
    />
  )
}

export default Introduction
