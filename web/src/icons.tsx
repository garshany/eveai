import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 22, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CompassMark({ size = 38, ...props }: IconProps) {
  return (
    <IconBase size={size} {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2L12 2Z" />
      <path d="m7.4 7.4 2.2 4.9 4.8 4.3-2.1-4.9-4.9-4.3Z" />
      <circle cx="12" cy="12" r="1.15" />
    </IconBase>
  );
}

export function MenuIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 6h16M4 12h16M4 18h16" /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></IconBase>;
}

export function ChatIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 5.5h16v11H9l-5 3v-14Z" /></IconBase>;
}

export function RouteIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M7.7 16.8c2.8-1.8 2-4.1 4.8-5.3 2.1-.9 3.1-2.5 4.1-3.9" /></IconBase>;
}

export function MarketIcon(props: IconProps) {
  return <IconBase {...props}><path d="m4 13 9-9 7 7-9 9-7-7Z" /><circle cx="14.5" cy="8.5" r="1" /></IconBase>;
}

export function TargetIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 1v5M12 18v5M1 12h5M18 12h5" /></IconBase>;
}

export function PilotIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="8" r="3.5" /><path d="M5 21c.7-4 3.1-6 7-6s6.3 2 7 6" /><path d="M4 12a8 8 0 0 1 16 0" /></IconBase>;
}

export function PaperclipIcon(props: IconProps) {
  return <IconBase {...props}><path d="m9.5 12.8 5.7-5.7a3 3 0 1 1 4.2 4.2l-8.5 8.5a5 5 0 1 1-7.1-7.1l8.1-8.1" /></IconBase>;
}

export function SendIcon(props: IconProps) {
  return <IconBase {...props}><path d="m3 4 18 8-18 8 3-8-3-8Z" /><path d="M6 12h15" /></IconBase>;
}

export function ChevronIcon(props: IconProps) {
  return <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.6 2.6L16.5 9" /></IconBase>;
}

export function ShieldIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Z" /><path d="M9.5 12.2 11 13.7l3.7-3.7" /></IconBase>;
}

export function LogOutIcon(props: IconProps) {
  return <IconBase {...props}><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" /></IconBase>;
}

export function CloseIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
}

export function CopyIcon(props: IconProps) {
  return <IconBase {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></IconBase>;
}

export function ArrowDownIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 4v16m0 0 6-6m-6 6-6-6" /></IconBase>;
}

export function AlertIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.2" r="0.4" fill="currentColor" /></IconBase>;
}

export function ChartIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 4v16h16" /><path d="M8.5 16v-4.5M12.5 16V7.5M16.5 16v-3" /></IconBase>;
}

export function GearIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></IconBase>;
}
