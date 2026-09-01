import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../state/libraryStore'
import { search, useSearchStore } from '../state/searchStore'
import { suggest, useSuggestStore, type Suggestion } from '../state/suggestStore'
import { ui, useUIStore } from '../state/uiStore'
import { Artwork } from './Artwork'
import { ChevronLeft, ChevronRight, CloseIcon, SearchIcon } from './Icons'

export function TopBar({ scrolled }: { scrolled: boolean }) {
  const query = useSearchStore((s) => s.query)
  const suggestions = useSuggestStore((s) => s.items)
  const sugStatus = useSuggestStore((s) => s.status)
  const history = useLibraryStore((s) => s.searchHistory)
  const canBack = useUIStore((s) => s.history.length > 0)
  const canForward = useUIStore((s) => s.future.length > 0)
  const route = useUIStore((s) => s.route)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  // Recent searches replace provider suggestions while the field is empty.
  const items: Suggestion[] = query.trim()
    ? suggestions
    : history.map((term) => ({ key: `h:${term}`, label: term, sub: 'Recent search', kind: 'history' as const }))

  useEffect(() => {
    const focus = () => inputRef.current?.select()
    window.addEventListener('melo:focus-search', focus)
    return () => window.removeEventListener('melo:focus-search', focus)
  }, [])

  useEffect(() => {
    if (route.name === 'search') inputRef.current?.focus()
  }, [route.name])

  // Clicking anywhere outside the search box closes the dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setActive(-1)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const close = () => {
    setOpen(false)
    setActive(-1)
  }

  const submitQuery = () => {
    const q = query.trim()
    if (!q) return
    close()
    ui.navigate({ name: 'search' })
    void search.run(q)
  }

  const select = (item: Suggestion) => {
    close()
    switch (item.kind) {
      case 'artist':
        search.setQuery(item.label)
        if (item.artistName) ui.navigate({ name: 'artist', artist: item.artistName })
        return
      case 'album':
        search.setQuery(item.label)
        if (item.albumKey) ui.navigate({ name: 'album', key: item.albumKey })
        return
      default:
        // history, song, video: run a real search for the suggestion's title
        search.setQuery(item.label)
        ui.navigate({ name: 'search' })
        void search.run(item.label)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(items.length - 1, a + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter') {
      // Selecting a highlighted suggestion takes precedence over a plain
      // submit; otherwise we let the form's onSubmit handle Enter.
      if (open && active >= 0 && items[active]) {
        e.preventDefault()
        select(items[active])
      }
    }
  }

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

      <div className="search-box" ref={boxRef}>
        <form
          className="search-field"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            submitQuery()
          }}
        >
          <SearchIcon size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search songs, artists, albums"
            aria-label="Search"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls="search-suggestions"
            onFocus={() => {
              ui.navigate({ name: 'search' })
              setOpen(true)
              setActive(-1)
              if (query.trim()) suggest.request(query)
            }}
            onChange={(e) => {
              search.setQuery(e.target.value)
              setOpen(true)
              setActive(-1)
              suggest.request(e.target.value)
            }}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button
              className="icon-btn sm"
              type="button"
              onClick={() => {
                search.clear()
                suggest.clear()
              }}
              aria-label="Clear search"
            >
              <CloseIcon size={14} />
            </button>
          )}
          {!query && <span className="kbd">Ctrl K</span>}
        </form>

        {open && items.length > 0 && (
          <div className="suggest-dropdown" id="search-suggestions" role="listbox" aria-label="Search suggestions">
            <div className="suggest-head">
              {query.trim() ? (sugStatus === 'loading' ? 'Searching…' : 'Suggestions') : 'Recent searches'}
            </div>
            {items.map((item, i) => (
              <button
                key={item.key}
                className={`suggest-item ${i === active ? 'active' : ''}`}
                role="option"
                aria-selected={i === active}
                type="button"
                onMouseDown={(e) => e.preventDefault()} // keep the input focused
                onClick={() => select(item)}
                onMouseEnter={() => setActive(i)}
              >
                <Artwork src={item.artwork} alt={item.label} style={{ width: 36, height: 36 }} />
                <span className="suggest-main">
                  <span className="suggest-label">{item.label}</span>
                  <span className="suggest-sub" style={{ display: 'block' }}>
                    {item.sub}
                  </span>
                </span>
                {item.kind === 'history' && <SearchIcon size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}
