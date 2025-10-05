import React from 'react';

type Variant = 'primary' | 'ghost';

export default function Button({ variant='primary', children, ...rest }: React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement> & { variant?: Variant }) {
  const style: React.CSSProperties = variant === 'primary' ? {
    background: 'var(--button-primary-bg, var(--color-accent))',
    color: 'var(--button-primary-fg, var(--color-bg))',
    border: '1px solid var(--button-primary-border, var(--color-accent))',
  } : {
    background: 'var(--button-ghost-bg, transparent)',
    color: 'var(--button-ghost-fg, var(--color-text))',
    border: '1px solid var(--button-ghost-border, var(--color-border))',
  };
  return (
    <button {...rest} style={{ padding: 'var(--space-sm) var(--space-md)', borderRadius: 'var(--radius-md)px', cursor: 'pointer', ...style }}>
      {children}
    </button>
  );
}

