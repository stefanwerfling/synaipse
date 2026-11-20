import {api} from './Api.js';
import {el} from './Dom.js';
import {openModal} from './Modal.js';
import {defineMessages, tc} from './I18n.js';

/**
 * Stream an LLM summary of a note into a dialog (plan P7 / D2), with
 * "Save to frontmatter.summary" once the summary is complete. Closing
 * the dialog aborts the stream. `onSaved` runs after the note was
 * written.
 */
const t = defineMessages('summarizeDialog', {
    streaming: 'streaming…',
    save: 'Save to frontmatter.summary',
    title: 'Summarize · {title}',
    error: 'error: {message}',
    saving: 'saving…',
    saved: '✓ Saved',
    saveFailed: 'Save failed',
    done: 'done'
});

export const openSummarizeDialog = async (note: {id: string; title: string}, onSaved: () => void): Promise<void> => {
    const body = el('div', {class: 'summarize-modal-body', attrs: {'aria-live': 'polite'}});
    const status = el('div', {class: 'summarize-modal-status', attrs: {role: 'status'}, text: t('streaming')});
    const closeBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: tc('close')
    });
    const saveBtn = el('button', {
        class: 'btn btn-primary',
        attrs: {type: 'button', disabled: 'true'},
        text: t('save')
    }) as HTMLButtonElement;

    const ctl = new AbortController();
    const close = (): void => {
        ctl.abort();
        modal.close();
    };

    const modal = openModal({
        title: t('title', {title: note.title}),
        subtitle: status,
        closeLabel: tc('close'),
        size: 'md',
        layout: 'sections',
        className: 'summarize-modal',
        body,
        footer: [closeBtn, saveBtn],
        initialFocus: closeBtn,
        onDismiss: close
    });
    closeBtn.addEventListener('click', close);

    let finalSummary = '';

    try {
        for await (const event of api.summarizeNote(note.id, {signal: ctl.signal})) {
            if (event.kind === 'token') {
                body.textContent = (body.textContent ?? '') + event.text;
            } else if (event.kind === 'done') {
                finalSummary = event.summary;
                body.textContent = event.summary;
                status.textContent = t('done');
            } else if (event.kind === 'error') {
                status.textContent = t('error', {message: event.message});
            }
        }

        if (finalSummary.length > 0) {
            const summary = finalSummary;
            saveBtn.removeAttribute('disabled');
            saveBtn.onclick = async (): Promise<void> => {
                saveBtn.setAttribute('disabled', 'true');
                saveBtn.textContent = t('saving');
                try {
                    const current = await api.getNote(note.id);
                    await api.writeNote({path: note.id, content: current.content, frontmatter: {...current.frontmatter, summary}});
                    onSaved();
                    saveBtn.textContent = t('saved');
                    window.setTimeout(close, 800);
                } catch (cause) {
                    saveBtn.textContent = t('saveFailed');
                    status.textContent = String(cause);
                }
            };
        }
    } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
            status.textContent = t('error', {message: String(cause)});
        }
    }
};
