import { useEffect, useState } from 'react'
import type { RpcExtensionUIResponse, RpcUiDialog } from '@shared/rpc-types'

interface Props {
  dialog: RpcUiDialog
  onRespond: (response: RpcExtensionUIResponse) => void
}

/** Modal for a blocking extension dialog (select / confirm / input / editor). */
export default function ExtensionUi({ dialog, onRespond }: Props) {
  const [text, setText] = useState(dialog.prefill ?? '')

  useEffect(() => {
    setText(dialog.prefill ?? '')
  }, [dialog.id, dialog.prefill])

  const respond = (value: string): void => onRespond({ type: 'extension_ui_response', id: dialog.id, value })
  const confirm = (confirmed: boolean): void => onRespond({ type: 'extension_ui_response', id: dialog.id, confirmed })
  const cancel = (): void => onRespond({ type: 'extension_ui_response', id: dialog.id, cancelled: true })

  return (
    <div className="ui-dialog-overlay" onClick={cancel}>
      <div className="ui-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="ui-dialog-title">{dialog.title}</div>
        {dialog.message ? <div className="ui-dialog-message">{dialog.message}</div> : null}

        {dialog.method === 'select' ? (
          <div className="ui-dialog-options">
            {(dialog.options ?? []).map((option) => (
              <button key={option} className="btn" onClick={() => respond(option)}>
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {dialog.method === 'confirm' ? (
          <div className="ui-dialog-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
            <button className="btn" onClick={() => confirm(false)}>
              No
            </button>
            <button className="btn primary" onClick={() => confirm(true)}>
              Yes
            </button>
          </div>
        ) : null}

        {dialog.method === 'input' ? (
          <>
            <input
              className="ui-dialog-input"
              autoFocus
              value={text}
              placeholder={dialog.placeholder}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') respond(text)
                if (event.key === 'Escape') cancel()
              }}
            />
            <div className="ui-dialog-actions">
              <button className="btn" onClick={cancel}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => respond(text)}>
                Submit
              </button>
            </div>
          </>
        ) : null}

        {dialog.method === 'editor' ? (
          <>
            <textarea
              className="ui-dialog-editor"
              autoFocus
              rows={8}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <div className="ui-dialog-actions">
              <button className="btn" onClick={cancel}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => respond(text)}>
                Submit
              </button>
            </div>
          </>
        ) : null}

        {dialog.method === 'select' ? (
          <div className="ui-dialog-actions">
            <button className="btn" onClick={cancel}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
