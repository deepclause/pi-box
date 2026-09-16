import { useMemo } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value
      return `<pre><code class="hljs">${highlighted}</code></pre>\n`
    }
  }
})

/** Render assistant markdown to sanitized HTML with syntax-highlighted code. */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['class'] })
  }, [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
