/**
 * Standard success shape: minified JSON as the one text block every tool returns. Minified, not
 * pretty-printed — indentation is pure token cost for the model reading it (#72).
 *
 * `meta` is the MCP result's out-of-band `_meta`: server-side claims (e.g. what a batch actually
 * committed, issue #388 §C) that Aleph's own tool layer reads, deliberately kept out of the text
 * the model sees so a payload a model could influence never becomes the record of what happened.
 */
export function textResult(
  value: unknown,
  meta?: Record<string, unknown>
): { content: [{ type: 'text'; text: string }]; _meta?: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(meta && { _meta: meta })
  }
}

export function imageResult(
  value: unknown,
  image: { data: string; mimeType: string },
  meta?: Record<string, unknown>
): {
  content: [{ type: 'text'; text: string }, { type: 'image'; data: string; mimeType: string }]
  _meta?: Record<string, unknown>
} {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value) },
      { type: 'image', data: image.data, mimeType: image.mimeType }
    ],
    ...(meta && { _meta: meta })
  }
}
