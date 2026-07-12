'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Panel width in px (default 520). */
  width?: number;
  /** Clicking the backdrop closes the modal (default true). */
  closeOnBackdrop?: boolean;
  footer?: ReactNode;
  children?: ReactNode;
}

/**
 * Pure close-decision logic, extracted so it is testable without a DOM:
 * Escape always closes, backdrop closes iff closeOnBackdrop, clicks inside
 * the content never close.
 */
export function modalCloseIntent(
  kind: 'backdrop' | 'escape' | 'content',
  opts: { closeOnBackdrop: boolean },
): boolean {
  if (kind === 'escape') return true;
  if (kind === 'backdrop') return opts.closeOnBackdrop;
  return false;
}

/**
 * Locks body scrolling and returns a restore function. Takes the body as an
 * argument (rather than reading document) so the lock/restore contract is
 * testable in a node environment.
 */
export function applyBodyScrollLock(body: { style: { overflow: string } }): () => void {
  const prev = body.style.overflow;
  body.style.overflow = 'hidden';
  return () => {
    body.style.overflow = prev;
  };
}

export function Modal({
  open,
  onClose,
  title,
  width = 520,
  closeOnBackdrop = true,
  footer,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes while open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalCloseIntent('escape', { closeOnBackdrop })) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose, closeOnBackdrop]);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    return applyBodyScrollLock(document.body);
  }, [open]);

  // Focus trap-lite: move focus into the dialog on open.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Portals need a document; during SSR render nothing.
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && modalCloseIntent('backdrop', { closeOnBackdrop })) {
          onClose();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'var(--bg-modal-backdrop)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-6)',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="modal-box"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: 'calc(100vw - 2 * var(--space-6))',
          maxHeight: 'calc(100vh - 2 * var(--space-8))',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-modal)',
          outline: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-5) var(--space-5) var(--space-3)',
          }}
        >
          <div
            style={{
              fontSize: 'var(--fs-lg)',
              fontWeight: 700,
              color: 'var(--text-strong)',
              letterSpacing: -0.3,
              minWidth: 0,
            }}
          >
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            className="fr-focus"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              flexShrink: 0,
              width: 28,
              height: 28,
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-muted)',
              fontSize: 'var(--fs-md)',
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 'var(--space-2) var(--space-5) var(--space-5)', overflowY: 'auto' }}>
          {children}
        </div>
        {footer != null && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: 'var(--space-3) var(--space-5)',
              borderTop: '1px solid var(--border-faint)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
