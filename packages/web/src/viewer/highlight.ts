import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import dos from 'highlight.js/lib/languages/dos'
import gcode from 'highlight.js/lib/languages/gcode'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import openscad from 'highlight.js/lib/languages/openscad'
import powershell from 'highlight.js/lib/languages/powershell'
import properties from 'highlight.js/lib/languages/properties'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * Syntax highlighting for the text preview. A lazy chunk of its own (with the text preview), so
 * the highlighter and its grammars load the first time a text file is opened and never before.
 *
 * Only the languages a 3D-printing library holds: data and markup (JSON, XML — which is also what
 * a 3MF's parts and a slicer's `.config` are — YAML, INI/TOML), G-code, OpenSCAD, notes, and the
 * odd script. Anything else is shown as plain text.
 */
const LANGUAGES = {
  bash,
  css,
  dos,
  gcode,
  ini,
  javascript,
  json,
  markdown,
  openscad,
  powershell,
  properties,
  python,
  typescript,
  xml,
  yaml,
}
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar)

/** The grammar for a file extension (lower case, no dot), or undefined for plain text. */
export function languageOf(extension: string): keyof typeof LANGUAGES | undefined {
  switch (extension) {
    case 'json':
    case '3mfconfig':
      return 'json'
    case 'xml':
    case 'html':
    case 'htm':
    case 'svg':
    case 'model':
    case 'rels':
    case 'config':
      return 'xml'
    case 'yml':
    case 'yaml':
      return 'yaml'
    case 'ini':
    case 'cfg':
    case 'conf':
    case 'toml':
      return 'ini'
    case 'properties':
      return 'properties'
    case 'gcode':
    case 'gco':
    case 'g':
      return 'gcode'
    case 'scad':
      return 'openscad'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'py':
      return 'python'
    case 'js':
      return 'javascript'
    case 'ts':
      return 'typescript'
    case 'css':
      return 'css'
    case 'sh':
      return 'bash'
    case 'bat':
      return 'dos'
    case 'ps1':
      return 'powershell'
    default:
      return undefined
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The text as HTML: highlighted when its extension has a grammar, escaped plain text otherwise.
 * A slicer's `.config` may be INI rather than XML, so a document that does not start like markup
 * falls back to INI. The highlighter escapes everything it does not mark up, so the result is safe
 * to set as `innerHTML`.
 */
export function highlight(text: string, extension: string): string {
  let language = languageOf(extension)
  if (language === 'xml' && extension === 'config' && !text.trimStart().startsWith('<')) {
    language = text.trimStart().startsWith('{') ? 'json' : 'ini'
  }
  if (!language) return escapeHtml(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(text)
  }
}
