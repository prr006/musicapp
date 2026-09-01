import { useEffect, useRef } from 'react'
import { search, useSearchStore } from '../state/searchStore'
import { ui, useUIStore } from '../state/uiStore'
import { ChevronLeft, ChevronRight, CloseIcon, SearchIcon } from './Icons'

export function TopBar({ scrolled }: { scrolled: boolean }) {
  const query = useSearchStore((s) => s.query)
  const canBack = useUIStore((s) => s.history.length > 0)
  const canForward = useUIStore((s) => s.future.length > 0)
  const route = useUIStore((s) => s.route)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focus = () => inputRef.current?.select()
    window.addEventListener('melo:focus-search', focus)
    return () => window.removeEventListener('melo:focus-search', focus)
  }, [])

  useEffect(() => {
    if (route.name === 'search') inputRef.current?.focus()
  }, [route.name])

  return (
    <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
      <div className="nav-buttons">
        <button className="icon-btn" onClick={() => ui.back()} disabled={!canBack} aria-label="Back" type="button">
          <ChevronLeft size={19} />
        </button>
        <button className="icon-btn" onClick={() => ui.forward()} disabled={!canForward} aria-label="Forward" type="button">
          <ChevronRight size={19} />
        </button>
      </div>

      <form
        className="search-field"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          ui.navigate({ name: 'search' })
          void search.run(query)
        }}
      >
        <SearchIcon size={17} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search songs, artists, albums"
          aria-label="Search"
          onFocus={() => ui.navigate({ name: 'search' })}
          onChange={(e) => search.setQuery(e.target.value)}
        />
        {query && (
          <button
            className="icon-btn sm"
            type="button"
            onClick={() => search.clear()}
            aria-label="Clear search"
          >
            <CloseIcon size={14} />
          </button>
        )}
        {!query && <span className="kbd">Ctrl K</span>}
      </form>
    </header>
  )
}
