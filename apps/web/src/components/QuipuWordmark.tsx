import type { SVGProps } from "react";

/** The brand mark: three hanging cords with a knot each, read as a stylised "Q". */
export function QuipuWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 44 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2 3h40M8 6v26M22 6v18M36 6v22"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="22" r="4" fill="currentColor" />
      <circle cx="22" cy="17" r="4" fill="currentColor" />
      <circle cx="36" cy="26" r="4" fill="currentColor" />
    </svg>
  );
}
