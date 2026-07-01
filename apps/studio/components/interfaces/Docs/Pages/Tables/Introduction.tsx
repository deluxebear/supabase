import { useParams } from 'common'

import { DocSection } from '../../DocSection'
import PublicSchemaNotEnabledAlert from '../../PublicSchemaNotEnabledAlert'
import CodeSnippet from '@/components/interfaces/Docs/CodeSnippet'
import { GeneratingTypes } from '@/components/interfaces/Docs/GeneratingTypes'
import { InlineLink } from '@/components/ui/InlineLink'
import { useProjectPostgrestConfigQuery } from '@/data/config/project-postgrest-config-query'
import { t as $t } from '@/lib/i18n'

interface IntroductionProps {
  selectedLang: 'bash' | 'js'
}

const Introduction = ({ selectedLang }: IntroductionProps) => {
  const { ref: projectRef } = useParams()

  const { data: config, isSuccess } = useProjectPostgrestConfigQuery({ projectRef })

  const isPublicSchemaEnabled = config?.db_schema
    .split(',')
    .map((name) => name.trim())
    .includes('public')

  return (
    <div className="flex flex-col flex-1">
      <DocSection
        title={$t('Introduction')}
        content={
          <p>
            {$t('All views and tables in the')} <code>public</code>{' '}
            {$t(
              'schema and accessible by the active database role for a request are available for querying.'
            )}
          </p>
        }
        snippets={isSuccess && !isPublicSchemaEnabled && <PublicSchemaNotEnabledAlert />}
      />

      <DocSection
        title={$t('Non-exposed tables')}
        content={
          <p>
            {$t(
              "If you don't want to expose tables in your API, simply add them to a different schema (not the"
            )}{' '}
            <code>public</code> schema).
          </p>
        }
      />

      <GeneratingTypes selectedLang={selectedLang} />

      <DocSection
        title={
          <>
            {$t('GraphQL')} <span className="lowercase font-normal">vs</span> {$t('Supabase')}
          </>
        }
        content={
          <>
            <p>
              {$t(
                'If you have a GraphQL background, you might be wondering if you can fetch your data in a single round-trip. The answer is yes!'
              )}
            </p>
            <p>
              {$t(
                'The syntax is very similar. This example shows how you might achieve the same thing with Apollo GraphQL and Supabase.'
              )}
            </p>
            <h4 className="text-foreground-light mt-8 font-medium">{$t('Still want GraphQL?')}</h4>
            <p>
              {$t(
                'If you still want to use GraphQL, you can. Supabase provides you with a full Postgres database, so as long as your middleware can connect to the database then you can still use the tools you love. You can find the database connection details'
              )}{' '}
              <InlineLink href={`/project/${projectRef}/database/settings`}>
                {$t('in the settings.')}
              </InlineLink>
            </p>
          </>
        }
        snippets={
          <>
            <CodeSnippet selectedLang={selectedLang} snippet={localSnippets.withApollo()} />
            <CodeSnippet selectedLang={selectedLang} snippet={localSnippets.withSupabase()} />
          </>
        }
      />
    </div>
  )
}

const localSnippets = {
  withApollo: () => ({
    title: 'With Apollo GraphQL',
    bash: {
      language: 'js',
      code: `
const { loading, error, data } = useQuery(gql\`
  query GetDogs {
    dogs {
      id
      breed
      owner {
        id
        name
      }
    }
  }
\`)`,
    },
    js: {
      language: 'js',
      code: `
const { loading, error, data } = useQuery(gql\`
  query GetDogs {
    dogs {
      id
      breed
      owner {
        id
        name
      }
    }
  }
\`)`,
    },
  }),
  withSupabase: () => ({
    title: 'With Supabase',
    bash: {
      language: 'js',
      code: `
const { data, error } = await supabase
  .from('dogs')
  .select(\`
      id, breed,
      owner (id, name)
  \`)
`,
    },
    js: {
      language: 'js',
      code: `
const { data, error } = await supabase
  .from('dogs')
  .select(\`
      id, breed,
      owner (id, name)
  \`)
`,
    },
  }),
}

export default Introduction
