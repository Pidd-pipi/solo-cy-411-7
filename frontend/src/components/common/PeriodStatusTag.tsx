import { Tag } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { PeriodStatus, PERIOD_STATUS_COLORS, PERIOD_STATUS_LABELS } from '../../constants/accounting';

interface Props {
  status: PeriodStatus;
  version?: number;
}

export function PeriodStatusTag({ status, version }: Props) {
  return (
    <Tag color={PERIOD_STATUS_COLORS[status]} icon={status === PeriodStatus.CLOSED ? <LockOutlined /> : undefined}>
      {PERIOD_STATUS_LABELS[status]}
      {status === PeriodStatus.CLOSED && version ? ` v${version}` : ''}
    </Tag>
  );
}
