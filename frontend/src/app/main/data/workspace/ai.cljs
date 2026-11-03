(ns app.main.data.workspace.ai
  (:require
   [clojure.string :as str]
   [promesa.core :as p]))

(def initial-state
  {:messages [] :draft "" :image nil :answer "" :tools {} :context nil :citations [] :busy false :error nil
   :plan nil :plans [] :plan-scope nil :execution nil :executing false :cancelling false})

(defn send-on-enter?
  [^js event]
  (and (= "Enter" (.-key event))
       (not (.-shiftKey event))
       (not (.-isComposing event))
       (not (when-let [^js native (.-nativeEvent event)] (.-isComposing native)))
       (not= 229 (.-keyCode event))))

(defn get-pasted-image
  [clipboard]
  (some (fn [item]
          (when (and (= "file" (.-kind item)) (str/starts-with? (.-type item) "image/"))
            (.getAsFile item)))
        (array-seq (.-items clipboard))))

(defn get-chat-messages
  [messages]
  (let [recent (vec (take-last 10 messages))
        image-index (last (keep-indexed #(when (:image %2) %1) recent))]
    (mapv (fn [index message]
            (select-keys message (if (= index image-index) [:role :content :image] [:role :content])))
          (range) recent)))

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
  [state {:keys [type context name status text answer citedShapeIds message plan plans result]}]
  (case type
    "context" (assoc state :context context)
    "tool" (assoc-in state [:tools name] status)
    "delta" (update state :answer str text)
    "plan" (assoc state :plan plan :plans [] :execution nil)
    "plans" (assoc state :plans plans :plan (when (= 1 (count plans)) (first plans)) :execution nil)
    "execution" (assoc state :execution result :plan nil :plans [] :busy false :executing false :cancelling false)
    "done" (-> state
               (assoc :answer "" :citations citedShapeIds :busy false)
               (update :messages conj {:role "assistant" :content answer
                                       :citations citedShapeIds :context (:context state)}))
    "error" (assoc state :answer "" :busy false :error message :plan nil :plans [] :executing false :cancelling false)
    state))

(defn select-plan
  [state id]
  (if-let [plan (and (not (:busy state)) (some #(when (= id (:id %)) %) (:plans state)))]
    (assoc state :plan plan)
    state))

(defn get-batch-count
  [plan]
  (js/Math.ceil (/ (count (:operations plan)) 10)))

(def tool-labels
  {"create_rectangle" "创建矩形" "create_text" "创建文本" "create_frame" "创建画板"
   "create_image" "插入生成图片" "set_image" "替换图片填充（保留对象）"
   "set_text" "修改文本" "set_fill" "替换为单个纯色填充" "set_bounds" "修改位置和尺寸"
   "set_corner_radius" "设置矩形圆角" "create_component" "复用组件"})

(defn get-operation-summary
  [operation]
  (str/join " · "
            (cond-> []
              (contains? operation :borderRadius) (conj (str "四角统一圆角：" (:borderRadius operation)))
              (:cornerRadii operation) (conj (str "圆角（左上/右上/右下/左下）：" (str/join " / " (:cornerRadii operation))))
              (contains? operation :text) (conj (str "文本：" (:text operation)))
              (:color operation) (conj (str "填充：" (:color operation) "，不透明度 " (:opacity operation)))
              (:image operation) (conj (str "PNG 图片：" (get-in operation [:image :width]) " × " (get-in operation [:image :height])))
              (:width operation) (conj (str "位置 (" (:x operation) ", " (:y operation) ")，尺寸 "
                                            (:width operation) " × " (:height operation)))
              (:fontFamily operation) (conj (str "字体：" (:fontFamily operation) " / " (:fontSize operation))))))

(defn request-advanced
  [scope action controller]
  (p/let [response (js/fetch "/api/agent/advanced"
                             #js {:method "POST" :credentials "same-origin"
                                  :headers #js {"Content-Type" "application/json"}
                                  :signal (.-signal controller)
                                  :body (js/JSON.stringify (clj->js (assoc scope :action action)))})
          body (.json response)]
    (if (.-ok response)
      (js->clj body :keywordize-keys true)
      (throw (js/Error. (or (.-message body) "高级设计请求失败，请检查图片、布局与服务配置。"))))))

(defn get-image-data-url
  [image]
  (str "data:image/png;base64," (:data image)))

(defn read-png
  [file]
  (if (or (nil? file) (not= "image/png" (.-type file)) (> (.-size file) 2097152))
    (p/rejected (js/Error. "请选择不超过 2 MB 的 PNG 图片。"))
    (p/let [bitmap (js/createImageBitmap file)
            width  (.-width bitmap)
            height (.-height bitmap)
            _      (.close bitmap)
            _      (when (or (> width 4096) (> height 4096))
                     (throw (js/Error. "图片宽高不能超过 4096。")))
            data   (p/create (fn [resolve reject]
                               (let [reader (js/FileReader.)]
                                 (set! (.-onload reader) #(resolve (.-result reader)))
                                 (set! (.-onerror reader) #(reject (js/Error. "无法读取图片。")))
                                 (.readAsDataURL reader file))))]
      {:data (second (str/split data #"," 2)) :width width :height height})))

(defn read-chat-image
  [file]
  (cond
    (or (nil? file) (not (contains? #{"image/png" "image/jpeg" "image/webp"} (.-type file)))
        (> (.-size file) 2097152))
    (p/rejected (js/Error. "请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片。"))

    (= "image/png" (.-type file))
    (read-png file)

    :else
    (p/let [bitmap (js/createImageBitmap file)]
      (try
        (when (or (> (.-width bitmap) 4096) (> (.-height bitmap) 4096))
          (throw (js/Error. "图片宽高不能超过 4096。")))
        (let [canvas (.createElement js/document "canvas")]
          (set! (.-width canvas) (.-width bitmap))
          (set! (.-height canvas) (.-height bitmap))
          (.drawImage (.getContext canvas "2d") bitmap 0 0)
          (p/let [blob (p/create (fn [resolve reject]
                                   (.toBlob canvas #(if % (resolve %) (reject (js/Error. "无法读取图片。"))) "image/png")))]
            (read-png blob)))
        (finally (.close bitmap))))))

(defn download-code-file
  [name content]
  (let [url    (js/URL.createObjectURL (js/Blob. #js [content] #js {:type "text/plain;charset=utf-8"}))
        anchor (.createElement js/document "a")]
    (set! (.-href anchor) url)
    (set! (.-download anchor) name)
    (.click anchor)
    (js/setTimeout #(js/URL.revokeObjectURL url) 1000)))

(defn get-fill-summary
  [fills]
  (if (seq fills)
    (str/join "；" (map #(str (cond
                               (:fillColorGradient %) "渐变填充"
                               (:fillImage %) "图片填充"
                               :else (or (:fillColor %) "未指定颜色"))
                             "，不透明度 " (or (:fillOpacity %) 1)) fills))
    "无填充"))

(defn decide-plan
  [action scope plan-id controller]
  (p/let [response (js/fetch (str "/api/agent/" action)
                             #js {:method "POST" :credentials "same-origin"
                                  :headers #js {"Content-Type" "application/json"}
                                  :signal (.-signal controller)
                                  :body (js/JSON.stringify (clj->js (assoc scope :planId plan-id)))})
          body (.json response)]
    (if (.-ok response)
      (js->clj body :keywordize-keys true)
      (throw (js/Error. (or (.-message body) "操作请求失败。请检查画布，服务不会自动重试。"))))))

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
