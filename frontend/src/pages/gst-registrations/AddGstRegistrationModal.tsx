import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Alert } from '../../components/ui/Alert';
import { gstRegistrationsApi } from '../../api/gst-registrations.api';
import { isValidGstin, getStateNameByCode, extractPanFromGstin } from '../../utils/gstin';
import { extractErrorMessage } from '../../utils/errors';
import { GstRegistrationType } from '../../api/types';

const AddGstinSchema = z.object({
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((val) => isValidGstin(val), {
      message: 'Enter a valid 15-character GSTIN with valid state code'
    }),
  legalName: z.string().min(1, 'Legal business name is required').max(255),
  tradeName: z.string().max(255).optional(),
  registrationType: z.enum([
    'REGULAR',
    'COMPOSITION',
    'ISD',
    'CASUAL',
    'NON_RESIDENT',
    'TCS_ECO',
    'TDS',
    'OIDAR'
  ]),
  effectiveDate: z.string().optional()
});

type AddGstinFormValues = z.infer<typeof AddGstinSchema>;

export interface AddGstRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  organizationId: string;
  organizationPan?: string | null;
  onSuccess: () => void;
}

export const AddGstRegistrationModal: React.FC<AddGstRegistrationModalProps> = ({
  isOpen,
  onClose,
  organizationId,
  organizationPan,
  onSuccess
}) => {
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<AddGstinFormValues>({
    resolver: zodResolver(AddGstinSchema),
    defaultValues: {
      registrationType: 'REGULAR'
    }
  });

  const enteredGstin = watch('gstin', '');
  const stateCode = enteredGstin.length >= 2 ? enteredGstin.substring(0, 2) : '';
  const detectedState = stateCode ? getStateNameByCode(stateCode) : '';
  const extractedPan = extractPanFromGstin(enteredGstin);

  const onSubmit = async (data: AddGstinFormValues) => {
    setApiError(null);

    // Verify PAN consistency if organization has a PAN registered
    if (organizationPan && extractedPan && extractedPan !== organizationPan) {
      setApiError(
        `GSTIN PAN (${extractedPan}) does not match organization PAN (${organizationPan}). Statutory regulations require distinct person registrations to share the same PAN.`
      );
      return;
    }

    try {
      await gstRegistrationsApi.create(organizationId, {
        gstin: data.gstin,
        legalName: data.legalName,
        tradeName: data.tradeName || undefined,
        registrationType: data.registrationType as GstRegistrationType,
        effectiveDate: data.effectiveDate || undefined
      });
      reset();
      onSuccess();
      onClose();
    } catch (err: unknown) {
      setApiError(extractErrorMessage(err, 'Failed to add GST registration.'));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add GSTIN Registration"
      description="Register an authorized state-level GSTIN under this business entity."
      maxWidth="md"
    >
      {apiError && (
        <Alert type="error" className="mb-4">
          {apiError}
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <Input
            label="Goods & Services Tax Identification Number (GSTIN)"
            placeholder="e.g. 27AAPFU0939F1ZV"
            isMonospace
            maxLength={15}
            required
            error={errors.gstin?.message}
            {...register('gstin')}
          />
          {detectedState && (
            <div className="mt-1 text-xs text-[#0F8B72] font-medium flex items-center gap-1">
              <span>Jurisdiction:</span>
              <span className="font-semibold">{detectedState}</span>
              <span className="font-mono text-slate-400">({stateCode})</span>
            </div>
          )}
        </div>

        <Input
          label="Legal Business Name (as on GST Certificate)"
          placeholder="e.g. Acme Retail Enterprises Private Limited"
          required
          error={errors.legalName?.message}
          {...register('legalName')}
        />

        <Input
          label="Trade Name (optional)"
          placeholder="e.g. Acme Tech Maharashtra Hub"
          error={errors.tradeName?.message}
          {...register('tradeName')}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Registration Type"
            options={[
              { value: 'REGULAR', label: 'Regular Taxpayer' },
              { value: 'COMPOSITION', label: 'Composition Scheme' },
              { value: 'ISD', label: 'Input Service Distributor' },
              { value: 'TCS_ECO', label: 'E-commerce Operator (TCS)' },
              { value: 'CASUAL', label: 'Casual Taxable Person' },
              { value: 'NON_RESIDENT', label: 'Non-Resident Taxable' }
            ]}
            error={errors.registrationType?.message}
            {...register('registrationType')}
          />

          <Input
            label="Effective Date"
            type="date"
            error={errors.effectiveDate?.message}
            {...register('effectiveDate')}
          />
        </div>

        <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-100">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="accent" isLoading={isSubmitting}>
            Save registration
          </Button>
        </div>
      </form>
    </Modal>
  );
};
