import { useEffect, type RefObject } from 'react';

/**
 * react-grid-layout items are CSS-transformed siblings, so a dropdown inside one
 * card can paint underneath the next card. While `open`, lift the enclosing grid
 * item above its siblings.
 */
export function useRaiseGridItem(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const item = ref.current?.closest<HTMLElement>('.react-grid-item');
    if (!item) return;
    item.style.zIndex = open ? '30' : '';
    return () => { item.style.zIndex = ''; };
  }, [open, ref]);
}
