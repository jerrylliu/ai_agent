import React from "react";
import { CheckCircle, AlertCircle } from "lucide-react";

interface KbFeedbackToastProps {
  feedback: {
    show: boolean;
    success: boolean;
    message: string;
  };
}

const KbFeedbackToast: React.FC<KbFeedbackToastProps> = ({ feedback }) => {
  if (!feedback.show) return null;

  return (
    <div className={`mx-6 mt-4 p-3 rounded-lg flex items-center space-x-2 ${feedback.success
        ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
        : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
      }`}>
      {feedback.success ? (
        <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
      ) : (
        <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
      )}
      <span className={`text-sm ${feedback.success
          ? 'text-green-700 dark:text-green-300'
          : 'text-red-700 dark:text-red-300'
        }`}>
        {feedback.message}
      </span>
    </div>
  );
};

export default KbFeedbackToast;
