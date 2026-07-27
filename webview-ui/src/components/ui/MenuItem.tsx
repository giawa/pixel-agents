import type { ReactNode } from 'react';

interface MenuItemProps {
  onClick?: () => void;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function MenuItem({ onClick, children, right, className = '', disabled }: MenuItemProps) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-none text-left ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:bg-btn-bg'} ${className}`}
    >
      <span>{children}</span>
      {right}
    </button>
  );
}
