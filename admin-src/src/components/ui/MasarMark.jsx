// The official MASAR mark, drawn from the client's vector artwork — the same
// path the public site uses, so the two never drift apart.
//
// Filled with currentColor rather than a baked-in brand value: one CSS colour
// recolours it, so a dark ground needs no separate reversed artwork. The
// viewBox starts at a non-zero origin because that is where the glyph sits in
// the source file; normalising it would require re-cutting the path, and a
// wrong offset puts the artwork off-screen entirely.
export function MasarMark({ className = '', title }) {
  return (
    <svg
      viewBox="175.88 369.57 239.65 76.01"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M364.303 384.503 L364.916 395.576 C310.764 415.699 257.952 445.575 232.801 426.894 C216.258 412.369 220.142 372.551 220.142 372.551 L227.964 369.618 C227.964 369.618 223.968 408.642 241.205 418.079 C269.287 431.954 346.088 387.983 364.303 384.503 M392.269 391.834 C380.494 392.336 363.741 403.24 347.796 408.563 L350.45 419.361 C365.45 413.166 382.206 403.031 393.628 404.497 C403.512 405.797 407.177 415.707 407.249 417.165 C407.321 418.623 387.901 418.444 383.941 408.38 L378.792 409.97 C379.156 430.025 402.918 437.627 409.749 428.438 C415.535 419.004 410.331 391.956 392.269 391.834 M180.877 412.698 L175.883 421.755 C201.899 432.695 223.933 417.144 253.438 399.806 L251.552 389.609 C227.91 404.177 202.923 418.734 180.877 412.698 M269.103 400.756 L269.103 396.985 L341.943 369.569 L341.943 373.34 Z"
      />
    </svg>
  );
}
