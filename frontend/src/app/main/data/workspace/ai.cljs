(ns app.main.data.workspace.ai
  (:require
   [clojure.string :as str]
   [promesa.core :as p]))

(def initial-state
  {:messages [] :draft "" :answer "" :tools {} :context nil :citations [] :busy false :error nil})

(defn get-connection-state
  [feature-enabled {:keys [enabled token-valid connection-status session-id]}]
  (cond
    (not feature-enabled)
    {:status :unavailable :message "当前部署尚未启用编辑器连接，请配置 MCP 功能后刷新页面。"}

    (not enabled)
    {:status :setup :action :settings :message "请先在「设置 → 集成」启用 MCP，并配置连接令牌。"}

    (not token-valid)
    {:status :setup :action :settings :message "MCP 令牌不存在或已过期，请到集成设置重新配置。"}

    (and (= connection-status "connected") (not (str/blank? session-id)))
    {:status :ready}

    (= connection-status "connecting")
    {:status :connecting :message "正在连接当前编辑器…"}

    :else
    {:status :disconnected :action :connect
     :message (if (= connection-status "error")
                "编辑器连接失败，请确认 MCP 服务运行后重试。"
                "当前编辑器尚未连接。连接后即可发送设计问题。")}))

(defn apply-event
  [state {:keys [type context name status text answer citedShapeIds message]}]
  (case type
    "context" (assoc state :context context)
    "tool" (assoc-in state [:tools name] status)
    "delta" (update state :answer str text)
    "done" (-> state
               (assoc :answer "" :citations citedShapeIds :busy false)
               (update :messages conj {:role "assistant" :content answer
                                       :citations citedShapeIds :context (:context state)}))
    "error" (assoc state :answer "" :busy false :error message)
    state))

(defn parse-chunk
  "保留跨网络分块的半行，完整事件逐行解码。"
  [pending chunk]
  (let [lines (str/split (str pending chunk) #"\n" -1)]
    {:pending (last lines)
     :events (mapv #(js->clj (js/JSON.parse %) :keywordize-keys true)
                   (remove str/blank? (butlast lines)))}))

(defn stream-chat
  [request controller on-event]
  (p/let [response (js/fetch "/api/agent/chat"
                             #js {:method "POST"
                                  :credentials "same-origin"
                                  :headers #js {"Content-Type" "application/json"}
                                  :signal (.-signal controller)
                                  :body (js/JSON.stringify (clj->js request))})
          _ (when-not (.-ok response)
              (p/let [body (.text response)]
                (let [event (try
                              (js->clj (js/JSON.parse (first (str/split-lines body))) :keywordize-keys true)
                              (catch :default _ nil))
                      message (:message event)]
                  (throw (js/Error. (cond
                                      (and (= "error" (:type event)) (string? message)) message
                                      (= 429 (.-status response)) "已有回答正在生成，请稍后重试。"
                                      :else "无法开始对话，请检查登录、模型配置及 MCP 连接。"))))))]
    (let [reader  (.getReader (.-body response))
          decoder (js/TextDecoder.)
          ended*  (atom false)]
      (letfn [(consume [pending]
                (p/let [part (.read reader)]
                  (if (.-done part)
                    (when-not (and @ended* (str/blank? pending))
                      (throw (js/Error. "连接中断，回答尚未完成，请重试。")))
                    (let [{:keys [pending events]}
                          (parse-chunk pending (.decode decoder (.-value part) #js {:stream true}))]
                      (doseq [event events]
                        (when (contains? #{"done" "error"} (:type event))
                          (reset! ended* true))
                        (on-event event))
                      (consume pending)))))]
        (-> (consume "")
            (p/finally #(.releaseLock reader)))))))
