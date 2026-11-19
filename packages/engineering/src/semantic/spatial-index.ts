export interface Box2D {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface IndexedItem<T> {
  id: string
  box: Box2D
  data: T
}

/**
 * High-performance 2D uniform grid spatial index.
 * Prevents O(N^2) quadratic checks when analyzing CAD drawings with thousands of entities.
 */
export class SpatialIndex2D<T> {
  private readonly cellSize: number
  private readonly grid = new Map<string, IndexedItem<T>[]>()
  private readonly items = new Map<string, IndexedItem<T>>()

  constructor(cellSize = 1000) {
    this.cellSize = cellSize > 0 ? cellSize : 1000
  }

  insert(id: string, box: Box2D, data: T): void {
    const item: IndexedItem<T> = { id, box, data }
    this.items.set(id, item)

    const minCellX = Math.floor(box.minX / this.cellSize)
    const maxCellX = Math.floor(box.maxX / this.cellSize)
    const minCellY = Math.floor(box.minY / this.cellSize)
    const maxCellY = Math.floor(box.maxY / this.cellSize)

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const key = `${cx}:${cy}`
        let cell = this.grid.get(key)
        if (!cell) {
          cell = []
          this.grid.set(key, cell)
        }
        cell.push(item)
      }
    }
  }

  query(box: Box2D): T[] {
    const minCellX = Math.floor(box.minX / this.cellSize)
    const maxCellX = Math.floor(box.maxX / this.cellSize)
    const minCellY = Math.floor(box.minY / this.cellSize)
    const maxCellY = Math.floor(box.maxY / this.cellSize)

    const candidates = new Set<IndexedItem<T>>()

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const cell = this.grid.get(`${cx}:${cy}`)
        if (cell) {
          for (const item of cell) {
            candidates.add(item)
          }
        }
      }
    }

    const results: T[] = []
    for (const item of candidates) {
      if (
        item.box.minX <= box.maxX &&
        item.box.maxX >= box.minX &&
        item.box.minY <= box.maxY &&
        item.box.maxY >= box.minY
      ) {
        results.push(item.data)
      }
    }

    return results
  }

  clear(): void {
    this.grid.clear()
    this.items.clear()
  }

  get size(): number {
    return this.items.size
  }
}
