let _generation = 0
let _controller = new AbortController()

export function bumpGeneration(): void {
  _generation++
  _controller.abort()
  _controller = new AbortController()
}

export function getSignal(): AbortSignal {
  return _controller.signal
}

export function getGeneration(): number {
  return _generation
}
