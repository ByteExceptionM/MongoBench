import * as React from 'react'
import { Input, type InputProps } from '@/components/ui/input'
import { rankSuggestions } from '@/lib/suggestions'
import { cn } from '@/lib/utils'

type AutocompleteInputProps = Omit<InputProps, 'value' | 'onChange' | 'onFocus' | 'onBlur'> & {
  value: string
  onValueChange: (value: string) => void
  suggestions: readonly string[]
  /** Layout of the positioning wrapper, e.g. `flex-1` or a fixed width. */
  wrapperClassName?: string
}

/** Input with a ranked suggestion list that owns Arrow keys, Tab, Enter and Escape while open. */
const AutocompleteInput = React.forwardRef<HTMLInputElement, AutocompleteInputProps>(
  (
    { value, onValueChange, suggestions, wrapperClassName, className, onKeyDown, ...props },
    ref
  ) => {
    const [open, setOpen] = React.useState(false)
    const [active, setActive] = React.useState(0)
    const listId = React.useId()
    const listRef = React.useRef<HTMLUListElement>(null)

    const matches = React.useMemo(() => rankSuggestions(value, suggestions), [value, suggestions])
    const visible = open && matches.length > 0
    const current = active < matches.length ? active : 0

    React.useEffect(() => {
      setActive(0)
    }, [value])

    React.useEffect(() => {
      if (visible) listRef.current?.children[current]?.scrollIntoView({ block: 'nearest' })
    }, [visible, current])

    const accept = (suggestion: string) => {
      onValueChange(suggestion)
      setOpen(false)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (visible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActive((current + 1) % matches.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActive((current - 1 + matches.length) % matches.length)
          return
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault()
          accept(matches[current]!)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          return
        }
      }
      onKeyDown?.(e)
    }

    return (
      <div className={cn('relative', wrapperClassName)}>
        <Input
          ref={ref}
          {...props}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={handleKeyDown}
          className={cn('w-full font-mono', className)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={visible ? `${listId}-${current}` : undefined}
          data-consumes-escape={visible ? '' : undefined}
        />
        {visible && (
          <ul
            ref={listRef}
            id={listId}
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-40 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            role="listbox"
            // Keep focus in the input so onBlur doesn't close the list before an option click registers.
            onMouseDown={(e) => e.preventDefault()}
          >
            {matches.map((s, i) => (
              <li
                key={s}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                onMouseEnter={() => setActive(i)}
                onClick={() => accept(s)}
                className={cn(
                  'cursor-pointer rounded-sm px-2 py-1 font-mono text-xs',
                  i === current ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
)
AutocompleteInput.displayName = 'AutocompleteInput'

export { AutocompleteInput }
