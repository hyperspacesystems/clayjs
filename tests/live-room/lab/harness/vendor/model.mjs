// The workbook model. A cell's fields are the saved attributes, one to one, so
// the writer has no decisions to make.
//
// Workbook: { rev: string, sheets: Sheet[], tag: object }
// Sheet:    { id, pos, name, freezeCols: number, cols: Col[], rows: Row[] }
// Col:      { id, pos, width?: number, fmt?: string }
// Row:      { id, pos, frozen: boolean, style?: string, cells: (Cell | null)[] }
// Cell:     { text: string, f?: string, v?: string, n?: true, t?: true, fmt?: string,
//             colspan?: number, rowspan?: number, hidden?: true, style?: string,
//             expect?: number | string }
export const cell = (text, attrs = {}) => ({ text, ...attrs });
