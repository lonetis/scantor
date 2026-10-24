import { describe, expect, it } from 'vitest'
import { stripAnsi, stripEscapes, toLogLines } from '../../app/utils/ansi'

describe('stripAnsi', () => {
  it('removes color and cursor sequences', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m and \u001B[1;32mbold green\u001B[m')).toBe('red and bold green')
    expect(stripAnsi('\u001B[2K\u001B[1Gdone')).toBe('done')
  })

  it('removes OSC sequences such as hyperlinks and titles', () => {
    expect(stripAnsi('\u001B]8;;https://evil.example\u0007click\u001B]8;;\u0007')).toBe('click')
    expect(stripAnsi('\u001B]0;title\u001B\\text')).toBe('text')
  })

  it('removes other escapes and control characters but keeps newlines and tabs', () => {
    expect(stripAnsi('a\u001B(Bb\u0007c\td\ne\u0000')).toBe('ab\u0007c\td\ne'.replace('\u0007', ''))
  })

  it('keeps only the text after a bare carriage return (progress bars)', () => {
    expect(stripAnsi('progress 10%\rprogress 100%\r\nnext')).toBe('progress 100%\nnext')
  })

  it('leaves markup as plain text', () => {
    expect(stripAnsi('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('toLogLines', () => {
  it('splits stripped text into lines without a trailing empty line', () => {
    expect(toLogLines('one\n\u001B[33mtwo\u001B[0m\n')).toEqual(['one', 'two'])
    expect(toLogLines('')).toEqual([])
  })
})

describe('stripEscapes', () => {
  it('removes escape sequences and control characters of single values', () => {
    expect(stripEscapes('\u001B[1mbold\u001B[0m')).toBe('bold')
    expect(stripEscapes('\u001B]8;;https://evil.example\u0007click\u001B]8;;\u0007 \u009B31mred\u0000')).toBe('click red')
  })

  it('keeps the whole text: tabs, newlines and carriage returns stay', () => {
    expect(stripEscapes('progress 10%\rprogress 100%\r\nnext\tcol')).toBe('progress 10%\rprogress 100%\r\nnext\tcol')
    expect(stripEscapes('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

