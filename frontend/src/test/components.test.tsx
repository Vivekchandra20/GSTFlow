import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/finance/StatusBadge';
import { CurrencyDisplay } from '../components/finance/CurrencyDisplay';
import { GstinDisplay } from '../components/finance/GstinDisplay';
import { TaxBreakdown } from '../components/finance/TaxBreakdown';
import { ProcessingTimeline } from '../components/finance/ProcessingTimeline';

describe('Design System Components', () => {
  describe('Button Component', () => {
    it('renders text and applies primary styling by default', () => {
      render(<Button>Upload MTR</Button>);
      const btn = screen.getByRole('button', { name: /upload mtr/i });
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveClass('bg-[#142B4A]');
    });

    it('renders disabled state and loading spinner correctly', () => {
      render(<Button isLoading disabled>Processing</Button>);
      const btn = screen.getByRole('button', { name: /processing/i });
      expect(btn).toBeDisabled();
    });

    it('renders variant styles properly', () => {
      const { rerender } = render(<Button variant="accent">Confirm</Button>);
      expect(screen.getByRole('button', { name: /confirm/i })).toHaveClass('bg-[#0F8B72]');

      rerender(<Button variant="danger">Delete</Button>);
      expect(screen.getByRole('button', { name: /delete/i })).toHaveClass('bg-red-600');
    });
  });

  describe('Financial Components', () => {
    it('CurrencyDisplay renders tabular monospace formatting', () => {
      render(<CurrencyDisplay amount="14850000.00" />);
      const el = screen.getByText('₹1,48,50,000.00');
      expect(el).toBeInTheDocument();
      expect(el).toHaveClass('font-mono');
    });

    it('GstinDisplay displays state code, PAN and state name', () => {
      render(<GstinDisplay gstin="27AAPFU0939F1ZV" showStateLabel={true} />);
      expect(screen.getByText('27')).toBeInTheDocument();
      expect(screen.getByText('AAPFU0939F')).toBeInTheDocument();
      expect(screen.getByText('(Maharashtra)')).toBeInTheDocument();
    });

    it('StatusBadge correctly maps statutory outcomes', () => {
      const { rerender } = render(<StatusBadge status="VALID" />);
      expect(screen.getByText('Valid')).toBeInTheDocument();

      rerender(<StatusBadge status="REVIEW_REQUIRED" />);
      expect(screen.getByText('Review Required')).toBeInTheDocument();

      rerender(<StatusBadge status="WARNING" />);
      expect(screen.getByText('Warning')).toBeInTheDocument();

      rerender(<StatusBadge status="ERROR" />);
      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('TaxBreakdown correctly computes total GST', () => {
      render(
        <TaxBreakdown
          taxableValue="100000.00"
          cgst="9000.00"
          sgst="9000.00"
          igst="0.00"
        />
      );
      expect(screen.getByText('₹1,00,000.00')).toBeInTheDocument();
      expect(screen.getAllByText('₹9,000.00')).toHaveLength(2);
      expect(screen.getByText('₹18,000.00')).toBeInTheDocument(); // 9000 + 9000 = 18000
    });

    it('ProcessingTimeline renders stages and checkpoint progress', () => {
      render(
        <ProcessingTimeline
          status="PROCESSING"
          progressPercentage={65}
          checkpoint="DOMAIN_PROCESSING"
        />
      );
      expect(screen.getByText('Checkpoint: DOMAIN_PROCESSING')).toBeInTheDocument();
      expect(screen.getByText('65%')).toBeInTheDocument();
      expect(screen.getByText('Upload Received')).toBeInTheDocument();
      expect(screen.getByText('Domain Engine Processing')).toBeInTheDocument();
    });
  });
});
