import { describe, it, expect } from 'vitest'
import { positionFor } from '../../src/review/diff.js'

// Fixtures taken from the FIRST live run that posted inline comments, kept
// because a green suite had already agreed with the wrong behaviour once.
// Two of the three placements were correct; the third was a comment about
// JSONLinesDataSource anchored to an untouched line inside CSVDataSource.
describe('live gate — the three real placements', () => {
  // data_source.py: the WRONG one. Line 63 is untouched context inside
  // CSVDataSource; the finding described JSONLinesDataSource and said "the
  // diff adds code", i.e. lineType 'added'.
  const dataSource = [
    '@@ -52,11 +52,12 @@ class CSVDataSource(DataSource):',
    ' class CSVDataSource(DataSource):',
    '     """Load data from CSV files."""',
    ' ',
    "-    def __init__(self, source_path: str, delimiter: str = ','):",
    "+    def __init__(self, source_path: str, delimiter: str = ',', quotechar: str = '\"'):",
    '         super().__init__(source_path)',
    '         self.delimiter = delimiter',
    '+        self.quotechar = quotechar',
    ' ',
    '     def load(self) -> List[Dict[str, Any]]:',
    '         """Load and parse CSV data."""',
    '         rows = []',
    "         with open(self.source_path, 'r', encoding='utf-8') as f:",
    '',
  ].join('\n')

  it('REFUSES the data_source.py:63 finding that landed on the wrong class', () => {
    // 'added' claimed, line 63 is context -> refused. Before the asymmetry
    // this produced a real, visibly wrong comment on a real merge request.
    expect(positionFor({ line: 63, lineType: 'added' }, { diff: dataSource })).toBeNull()
  })

  it('still places the added lines in that same file correctly', () => {
    expect(positionFor({ line: 55, lineType: 'added' }, { diff: dataSource })).toEqual({ oldLine: null, newLine: 55 })
    expect(positionFor({ line: 58, lineType: 'added' }, { diff: dataSource })).toEqual({ oldLine: null, newLine: 58 })
    // ...and via the accepted leniency direction, a 'context' claim on one.
    expect(positionFor({ line: 58, lineType: 'context' }, { diff: dataSource })).toEqual({ oldLine: null, newLine: 58 })
  })

  // data_filter.py:139 — the CORRECT one. A removed/added pair.
  const filter139 = [
    '@@ -136,4 +136,4 @@',
    '             return False',
    '         if inclusive:',
    '             return min_val <= value <= max_val',
    '-        return min_val < value < max_val',
    '+        return min_val <= value <= max_val',
    '',
  ].join('\n')

  it('places data_filter.py:139 on the ADDED side, not the removed one', () => {
    expect(positionFor({ line: 139, lineType: 'added' }, { diff: filter139 })).toEqual({ oldLine: null, newLine: 139 })
    // The removed twin is old line 139 and must stay on the old side.
    expect(positionFor({ line: 139, lineType: 'removed' }, { diff: filter139 })).toEqual({ oldLine: 139, newLine: null })
  })
})
