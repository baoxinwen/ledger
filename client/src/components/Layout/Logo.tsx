// 应用 Logo：在导航和移动端抽屉中保持一致的品牌展示。
import { Box, Typography } from '@mui/material';

interface LogoProps {
  compact?: boolean;
  isDarkMode: boolean;
}

export default function Logo({ compact = false, isDarkMode }: LogoProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box
        sx={{
          width: compact ? 32 : 40,
          height: compact ? 32 : 40,
          bgcolor: 'secondary.main',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 1,
        }}
      >
        <Typography
          sx={{
            fontFamily: '"Playfair Display", serif',
            fontWeight: 700,
            fontSize: compact ? '1.1rem' : '1.3rem',
            color: isDarkMode ? '#0a0a0f' : '#faf9f7',
            lineHeight: 1,
          }}
        >
          L
        </Typography>
      </Box>
      {!compact && (
        <Box>
          <Typography
            variant="subtitle1"
            sx={{
              fontFamily: '"Playfair Display", serif',
              fontWeight: 700,
              lineHeight: 1.2,
              color: 'text.primary',
              letterSpacing: '-0.01em',
            }}
          >
            ledger
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: 'secondary.main',
              fontSize: '0.6rem',
              letterSpacing: '0.15em',
            }}
          >
            智能记账
          </Typography>
        </Box>
      )}
    </Box>
  );
}
