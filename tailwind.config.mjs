/** @type {import('tailwindcss').Config} */
export default {
  content: ['./admin-src/index.html', './admin-src/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Same families the public site loads, so the marketing page and the
      // dashboard are visibly one product rather than two that share a logo.
      fontFamily: {
        sans   : ['IBM Plex Sans Arabic', 'IBM Plex Sans', 'system-ui', '-apple-system', 'sans-serif'],
        arabic : ['IBM Plex Sans Arabic', 'system-ui', 'sans-serif'],
        mono   : ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Premium palette — Linear-inspired
        ink: {
          50  : '#f8f8f9',
          100 : '#eeeef0',
          200 : '#d8d9dd',
          300 : '#b3b4bb',
          400 : '#8b8d96',
          500 : '#6c6e78',
          600 : '#54565f',
          700 : '#43444b',
          800 : '#2d2e34',
          900 : '#1c1d21',
          950 : '#0e0f12',
        },
        // MASAR new identity. Official palette: #8439FF (violet), #0017E0 (blue),
        // #FF93EE (pink), #101010 (black), #FFFFFF. 600 is the official violet;
        // every other step is a derived tint or shade.
        brand: {
          50  : '#F8F4FF',
          100 : '#F1EAFF',
          200 : '#DCCBFF',
          300 : '#C3A2FF',
          400 : '#A878FF',
          500 : '#9552FF',
          600 : '#8439FF',                            // official
          700 : '#6A2BD6',
          800 : '#4F1FA3',
          900 : '#331470',
        },
        accent: {
          violet  : '#8439FF',
          pink    : '#FF93EE',
          blue    : '#0017E0',
          emerald : '#10b981',
          amber   : '#f59e0b',
          rose    : '#f43f5e',
          sky     : '#0ea5e9',
        },
      },
      boxShadow: {
        'soft'    : '0 1px 2px rgba(16,18,27,0.04), 0 1px 3px rgba(16,18,27,0.06)',
        'card'    : '0 1px 2px rgba(16,18,27,0.04), 0 4px 12px rgba(16,18,27,0.04)',
        'pop'     : '0 4px 6px rgba(16,18,27,0.04), 0 20px 25px -5px rgba(16,18,27,0.10)',
        'inner-1' : 'inset 0 1px 0 rgba(255,255,255,0.04)',
        'glow'    : '0 0 0 4px rgba(132,57,255,0.14)',
      },
      borderRadius: {
        'xl'   : '14px',
        '2xl'  : '18px',
        '3xl'  : '24px',
      },
      animation: {
        'fade-in'   : 'fadeIn .25s ease-out',
        'slide-up'  : 'slideUp .35s cubic-bezier(0.16,1,0.3,1)',
        'pulse-slow': 'pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer'   : 'shimmer 1.6s linear infinite',
      },
      keyframes: {
        fadeIn  : { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideUp : { '0%': { opacity: 0, transform: 'translateY(8px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        shimmer : { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
    },
  },
  plugins: [],
};
