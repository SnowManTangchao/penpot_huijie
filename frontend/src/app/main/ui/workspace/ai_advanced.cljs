(ns app.main.ui.workspace.ai-advanced
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.workspace.ai :as ai]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.util.dom :as dom]
   [promesa.core :as p]
   [rumext.v2 :as mf]))

(mf/defc ai-advanced*
  [{:keys [scope model busy connected image-generation on-busy on-plan controller-ref]}]
  (let [state* (mf/use-state {:prompt "" :layout "" :images [] :size "1024x1024" :quality "low" :count 1 :target "react-css"})
        state  @state*
        alive* (mf/use-var true)
        run    (mf/use-fn
                (mf/deps scope)
                (fn [action]
                  (let [controller (js/AbortController.)]
                    (reset! controller-ref controller)
                    (on-busy true)
                    (swap! state* assoc :error nil)
                    (-> (ai/request-advanced scope action controller)
                        (p/then (fn [result]
                                  (when (and @alive* (identical? controller @controller-ref))
                                    (cond
                                      (:plan result) (on-plan scope (:plan result))
                                      (:layout result) (swap! state* assoc :layout (js/JSON.stringify (clj->js (:layout result)) nil 2)
                                                              :analysis result :metadata (:metadata result))
                                      (:images result) (swap! state* assoc :images (:images result) :metadata (:metadata result))
                                      (:files result) (swap! state* assoc :export result)))))
                        (p/catch (fn [error]
                                   (when (and @alive* (identical? controller @controller-ref))
                                     (swap! state* assoc :error (.-message error)))))
                        (p/finally (fn []
                                     (when (and @alive* (identical? controller @controller-ref))
                                       (reset! controller-ref nil)
                                       (on-busy false))))))))
        upload (fn [field event]
                 (let [file (aget (.-files (.-target event)) 0)]
                   (-> (ai/read-png file)
                       (p/then #(when @alive* (swap! state* assoc field % :error nil)))
                       (p/catch #(when @alive* (swap! state* assoc :error (.-message %)))))))
        layout-action (fn [type]
                        (try
                          (run {:type type :layout (js->clj (js/JSON.parse (:layout state)) :keywordize-keys true)
                                :target (:target state)})
                          (catch :default _ (swap! state* assoc :error "布局树不是有效 JSON，请修正后重试。"))))
        disabled (or busy (not connected))]
    (mf/with-effect []
      #(do (reset! alive* false)
           (when-let [controller @controller-ref] (.abort controller))))
    [:details {:class (stl/css :advanced)}
     [:summary {:class (stl/css :title)} "图片生成与代码工具"]
     [:div {:class (stl/css :content)}
      [:p {:class (stl/css :helper)} "图片会发送至服务端配置的模型。先预览并修正，画布写入仍需确认。PNG ≤ 2 MB，宽高 ≤ 4096。"]
      [:label {:class (stl/css :label) :for "ai-advanced-prompt"} "识别要求 / 图片提示词"]
      [:textarea {:id "ai-advanced-prompt" :class (stl/css :input) :rows 3 :max-length 4000
                  :value (:prompt state) :disabled busy
                  :on-change #(swap! state* assoc :prompt (dom/get-target-val %))}]
      [:label {:class (stl/css :label) :for "ai-source-image"} "截图 / 风格参考图（可选）"]
      [:input {:id "ai-source-image" :type "file" :accept "image/png" :disabled busy
               :on-change #(upload :image %)}]
      (when-let [image (:image state)]
        [:div
         [:img {:class (stl/css :preview) :src (ai/get-image-data-url image) :alt "待分析或编辑的参考图"}]
         [:> button* {:variant "ghost" :disabled busy :on-click #(swap! state* dissoc :image :mask)} "清除参考图"]])
      [:> button* {:variant "secondary" :disabled (or disabled (nil? (:image state)) (empty? model))
                   :on-click #(run {:type "analyze" :model model :image (:image state) :prompt (:prompt state)})} "识别截图结构"]
      (when-let [analysis (:analysis state)]
        [:div
         [:p {:class (stl/css :helper)} "识别置信度为模型自评。请核对文字、图片占位及层级，可在下方修正布局树。"]
         [:ul
          (for [item (:confidence analysis)]
            [:li {:key (:key item)} (:key item) " · " (js/Math.round (* 100 (:score item))) "% · " (:note item)])]])
      (when (seq (:layout state))
        [:div {:class (stl/css :group)}
         [:label {:class (stl/css :label) :for "ai-layout-tree"} "Layout Tree（可修正节点文字、层级、间距与样式）"]
         [:textarea {:id "ai-layout-tree" :class (stl/css :input) :rows 10 :value (:layout state) :disabled busy
                     :on-change #(swap! state* assoc :layout (dom/get-target-val %))}]
         [:> button* {:variant "secondary" :disabled disabled
                      :on-click #(try
                                   (run {:type "prepare-layout" :layout (js->clj (js/JSON.parse (:layout state)) :keywordize-keys true)})
                                   (catch :default _ (swap! state* assoc :error "请修正布局树 JSON。")))} "预览可编辑 UI 操作"]
         [:> button* {:variant "secondary" :disabled disabled :on-click #(layout-action "export-code")} "从布局树导出代码"]])
      [:hr]
      [:label {:class (stl/css :label) :for "ai-image-size"} "图片尺寸 / 比例"]
      [:select {:id "ai-image-size" :class (stl/css :input) :value (:size state) :disabled busy
                :on-change #(swap! state* assoc :size (dom/get-target-val %))}
       [:option {:value "1024x1024"} "1024 × 1024 · 1:1"]
       [:option {:value "1536x1024"} "1536 × 1024 · 3:2"]
       [:option {:value "1024x1536"} "1024 × 1536 · 2:3"]]
      [:label {:class (stl/css :label) :for "ai-image-quality"} "生成质量"]
      [:select {:id "ai-image-quality" :class (stl/css :input) :value (:quality state) :disabled busy
                :on-change #(swap! state* assoc :quality (dom/get-target-val %))}
       [:option {:value "low"} "低（快速试验）"] [:option {:value "medium"} "中"] [:option {:value "high"} "高"]]
      [:label {:class (stl/css :label) :for "ai-image-count"} "候选数量"]
      [:select {:id "ai-image-count" :class (stl/css :input) :value (:count state) :disabled busy
                :on-change #(swap! state* assoc :count (js/Number (dom/get-target-val %)))}
       [:option {:value 1} "1"] [:option {:value 2} "2"]]
      [:label {:class (stl/css :label) :for "ai-image-mask"} "局部编辑蒙版（可选；与参考图同尺寸，透明区域待重绘）"]
      [:input {:id "ai-image-mask" :type "file" :accept "image/png" :disabled busy :on-change #(upload :mask %)}]
      (when-not image-generation
        [:p {:class (stl/css :helper)} "图片生成暂不可用，请先配置图片模型服务。截图识别与代码导出可单独使用。"])
      [:> button* {:variant "secondary" :disabled (or disabled (not image-generation) (empty? (:prompt state)))
                   :on-click #(run {:type "generate-image"
                                    :request (cond-> (select-keys state [:prompt :size :quality :count])
                                               (:image state) (assoc :reference (:image state))
                                               (:mask state) (assoc :mask (:mask state)))})} "生成图片候选 / 编辑参考图"]
      (for [[index image] (map-indexed vector (:images state))]
        [:div {:key (:id image) :class (stl/css :group)}
         [:img {:class (stl/css :preview) :src (ai/get-image-data-url image) :alt (str "生成图片候选 " (inc index))}]
         [:p {:class (stl/css :helper)} "候选 " (inc index) " · " (:width image) " × " (:height image) " · 预览 5 分钟有效"]
         [:> button* {:variant "secondary" :disabled disabled
                      :on-click #(run {:type "prepare-image" :imageId (:id image) :replace false})} "选择并预览插入"]
         [:> button* {:variant "secondary" :disabled (or disabled (not= 1 (:selectionCount scope)))
                      :on-click #(run {:type "prepare-image" :imageId (:id image) :replace true})} "预览替换选中图片"]])
      (when-let [metadata (:metadata state)]
        [:details
         [:summary "模型耗时、用量与限制"]
         [:pre {:class (stl/css :code)} (js/JSON.stringify (clj->js metadata) nil 2)]])
      [:hr]
      [:label {:class (stl/css :label) :for "ai-code-target"} "代码目标"]
      [:select {:id "ai-code-target" :class (stl/css :input) :value (:target state) :disabled busy
                :on-change #(swap! state* assoc :target (dom/get-target-val %))}
       [:option {:value "react-css"} "React 组件 + CSS"]
       [:option {:value "html-css"} "HTML + CSS"]]
      [:> button* {:variant "secondary" :disabled disabled
                   :on-click #(run {:type "export-code" :target (:target state)})} "导出当前选区 / 页面代码"]
      (when-let [result (:export state)]
        [:div
         (for [[index warning] (map-indexed vector (:warnings result))]
           [:p {:key index :class (stl/css :helper)} warning])
         (for [[filename content] (:files result)]
           [:details {:key filename}
            [:summary (name filename)]
            [:> button* {:variant "secondary" :on-click #(ai/download-code-file (name filename) content)} "下载文件"]
            [:pre {:class (stl/css :code)} content]])])
      (when (:error state) [:p {:role "alert" :class (stl/css :error)} (:error state)])]]))
