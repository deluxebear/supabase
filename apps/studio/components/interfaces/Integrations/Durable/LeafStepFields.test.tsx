import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { useForm } from 'react-hook-form'
import { Form } from 'ui'
import { describe, expect, it } from 'vitest'

import { ALL_CAPABILITIES, workflowDefaultValues, type LeafStep } from './Durable.utils'
import type { WorkflowFormValues } from './Durable.utils'
import { LeafStepFields } from './LeafStepFields'
import type { DurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { customRender } from '@/tests/lib/custom-render'

mockAnimationsApi()

const Harness = ({
  type,
  capabilities = ALL_CAPABILITIES,
  allowBreak = false,
  hideTypeSelect,
}: {
  type: LeafStep['type']
  capabilities?: DurableCapabilities
  allowBreak?: boolean
  hideTypeSelect?: boolean
}) => {
  const form = useForm<WorkflowFormValues>({
    defaultValues: {
      ...workflowDefaultValues,
      steps: [{ ...workflowDefaultValues.steps[0], type }],
    },
  })
  return (
    <Form {...form}>
      <form>
        <LeafStepFields
          form={form}
          name="steps.0"
          capabilities={capabilities}
          allowBreak={allowBreak}
          hideTypeSelect={hideTypeSelect}
        />
      </form>
    </Form>
  )
}

describe('LeafStepFields', () => {
  it('hides the signal timeout when waiting without a timeout', async () => {
    customRender(<Harness type="signal" />)
    const user = userEvent.setup()
    expect(screen.getByLabelText('Signal timeout (seconds)')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Wait without a timeout' }))
    expect(screen.queryByLabelText('Signal timeout (seconds)')).not.toBeInTheDocument()
  })

  it('disables multipart without the capability', async () => {
    customRender(<Harness type="sql" capabilities={{ ...ALL_CAPABILITIES, multipart: false }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: /Multipart HTTP request/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('shows the parts field for multipart steps', () => {
    customRender(<Harness type="multipart" />)
    expect(screen.getByLabelText('Parts (JSON)')).toBeInTheDocument()
    expect(screen.getByLabelText('Timeout (seconds)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Request body')).not.toBeInTheDocument()
  })

  it.each([
    [false, false],
    [true, true],
  ])('allowBreak=%s controls the break option', async (allowBreak, present) => {
    customRender(<Harness type="sql" allowBreak={allowBreak} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox'))
    await screen.findByRole('option', { name: 'Run SQL' })
    expect(!!screen.queryByRole('option', { name: 'Break out of loop' })).toBe(present)
  })

  it('shows the cron field for schedule steps', () => {
    customRender(<Harness type="schedule" />)
    expect(screen.getByLabelText('Cron schedule')).toBeInTheDocument()
  })

  it('hides the type select when requested', () => {
    customRender(<Harness type="sql" hideTypeSelect />)
    expect(screen.queryByText('Step type')).not.toBeInTheDocument()
    expect(screen.getByLabelText('SQL statement')).toBeInTheDocument()
  })

  it('shows timeout and request body for http steps', () => {
    customRender(<Harness type="http" />)
    expect(screen.getByLabelText('Timeout (seconds)')).toBeInTheDocument()
    expect(screen.getByLabelText('Request body')).toBeInTheDocument()
  })
})
