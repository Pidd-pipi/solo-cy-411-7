import { Card, Space, Tag, Tooltip, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { Activity } from '../../types/entities';
import { formatCarbon, formatDate } from '../../utils/formatters';
import { CategoryBadge } from './CategoryBadge';

export function ActivityCard({ activity, locked }: { activity: Activity; locked?: boolean }) {
  return (
    <Card className={`activity-card${locked ? ' activity-card-locked' : ''}`} size="small">
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <CategoryBadge category={activity.category} />
          <Space size={4}>
            {locked ? (
              <Tooltip title="该月账期已结账，记录冻结">
                <Tag icon={<LockOutlined />} color="success">已结账</Tag>
              </Tooltip>
            ) : null}
            <Typography.Text strong>{formatCarbon(activity.carbonValue)}</Typography.Text>
          </Space>
        </Space>
        <Typography.Text>{activity.subType} · {Number(activity.amount).toFixed(2)} {activity.unit}</Typography.Text>
        <div className="split-line">
          <span>{formatDate(activity.recordDate)}</span>
          <span>{activity.note || '无备注'}</span>
        </div>
      </Space>
    </Card>
  );
}

