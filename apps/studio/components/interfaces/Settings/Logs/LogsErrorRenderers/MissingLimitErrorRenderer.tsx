import { t as $t } from '@/lib/i18n';

export const MissingLimitErrorRenderer = () => (
  <div className="flex flex-col items-center justify-center gap-2 text-center h-full px-5">
    <h3 className="text-lg text-foreground">{$t('Add a LIMIT to your query')}</h3>
    <p className="text-sm max-w-sm text-foreground-lighter">
      
                  {$t('Queries must include a LIMIT clause to avoid scanning large amounts of data. Add a LIMIT (for example,')} <span className="font-mono">{$t('LIMIT 100')}</span>{$t(') and run the query again.')}
                </p>
  </div>
)
