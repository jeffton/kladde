import { describe, expect, test } from 'vite-plus/test'
import {
  buildNoteKey,
  normalizeTs,
  resolveUniqueTitle,
  retargetPendingKey,
  samePendingOp,
  splitNoteKey,
} from './notesModel'

describe('notesModel helpers', () => {
  test('builds and splits keys with optional collections', () => {
    expect(buildNoteKey('shopping')).toBe('shopping')
    expect(buildNoteKey('shopping', 'home')).toBe('home/shopping')
    expect(splitNoteKey('home/shopping')).toEqual({ collection: 'home', title: 'shopping' })
    expect(splitNoteKey('shopping')).toEqual({ collection: '', title: 'shopping' })
  })

  test('normalizes timestamps to ISO strings and rejects invalid values', () => {
    expect(normalizeTs('2026-03-13T15:00:00+01:00')).toBe('2026-03-13T14:00:00.000Z')
    expect(normalizeTs('not-a-date')).toBe('')
    expect(normalizeTs()).toBe('')
  })

  test('retargets pending operations after a rename', () => {
    expect(
      retargetPendingKey(
        [
          { type: 'rename', oldKey: 'work/old', newKey: 'work/new' },
          { type: 'delete', key: 'work/old' },
          { type: 'star', key: 'work/old', starred: true },
        ],
        'work/old',
        'work/final',
      ),
    ).toEqual([
      { type: 'rename', oldKey: 'work/final', newKey: 'work/new' },
      { type: 'delete', key: 'work/final' },
      { type: 'star', key: 'work/final', starred: true },
    ])
  })

  test('compares pending operations by shape and payload', () => {
    expect(samePendingOp({ type: 'delete', key: 'a' }, { type: 'delete', key: 'a' })).toBe(true)
    expect(samePendingOp({ type: 'delete', key: 'a' }, { type: 'delete', key: 'b' })).toBe(false)
    expect(
      samePendingOp(
        { type: 'rename', oldKey: 'a', newKey: 'b' },
        { type: 'rename', oldKey: 'a', newKey: 'b' },
      ),
    ).toBe(true)
  })

  test('resolves unique duplicate note titles with numeric suffixes', () => {
    expect(resolveUniqueTitle(new Set(['note']), 'note')).toBe('note (2)')
    expect(resolveUniqueTitle(new Set(['note', 'note (2)']), 'note')).toBe('note (3)')
    expect(resolveUniqueTitle(new Set(['other']), 'note')).toBe('note')
  })
})
