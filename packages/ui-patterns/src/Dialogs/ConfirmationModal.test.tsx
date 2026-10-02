import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { setUiTranslator } from '../lib/i18n'
import { ConfirmationModal } from './ConfirmationModal'

describe('ConfirmationModal', () => {
  it('keeps an additional footer action separate from dismissal', async () => {
    const onCancel = vi.fn()
    const onAdditionalAction = vi.fn()

    render(
      <ConfirmationModal
        visible
        title="Assistant changes detected"
        additionalActionLabel="Discard changes"
        onCancel={onCancel}
        onAdditionalAction={onAdditionalAction}
        onConfirm={vi.fn()}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onAdditionalAction).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('does not dismiss while loading', async () => {
    const onCancel = vi.fn()

    render(
      <ConfirmationModal
        visible
        loading
        title="Saving notebook"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Saving notebook' })
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.pointerDown(dialog.parentElement!, { button: 0, ctrlKey: false })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('translates string confirm labels and alert text through the host translator', () => {
    setUiTranslator((key) => `zh:${key}`)
    try {
      render(
        <ConfirmationModal
          visible
          title="Enable feature"
          confirmLabel="Enable it"
          alert={{ title: 'Risky change', description: 'Read before confirming' }}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      )

      expect(screen.getByRole('button', { name: 'zh:Enable it' })).toBeInTheDocument()
      expect(screen.getByText('zh:Risky change')).toBeInTheDocument()
      expect(screen.getByText('zh:Read before confirming')).toBeInTheDocument()
    } finally {
      setUiTranslator((key) => key)
    }
  })
})
