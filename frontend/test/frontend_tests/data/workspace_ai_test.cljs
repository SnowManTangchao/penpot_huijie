(ns frontend-tests.data.workspace-ai-test
  (:require
   [app.common.test-helpers.files :as cthf]
   [app.common.uuid :as uuid]
   [app.main.data.workspace.ai :as ai]
   [app.main.data.workspace.undo :as dwu]
   [app.main.store :as st]
   [app.plugins.api :as api]
   [cljs.test :refer [deftest is]]
   [clojure.string :as str]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [frontend-tests.helpers.state :as ths]
   [frontend-tests.tokens.helpers.state :as tohs]
   [potok.v2.core :as ptk]))

(deftest handles-split-network-events
  (let [first-part (ai/parse-chunk "" "{\"type\":\"del")
        next-part  (ai/parse-chunk (:pending first-part) "ta\",\"text\":\"你好\"}\n{\"type\":\"done\"}\n")]
    (is (empty? (:events first-part)))
    (is (= [{:type "delta" :text "你好"} {:type "done"}] (:events next-part)))
    (is (= "" (:pending next-part)))))

(deftest image-previews-use-png-data-and-display-source-dimensions
  (is (= "data:image/png;base64,aGVsbG8=" (ai/get-image-data-url {:data "aGVsbG8="})))
  (is (str/includes? (ai/get-operation-summary {:tool "set_image" :image {:width 1024 :height 1536}})
                     "1024 × 1536"))
  (is (= "替换图片填充（保留对象）" (get ai/tool-labels "set_image"))))

(deftest selects-only-offered-page-alternatives-before-confirmation
  (let [plans [{:id "a" :generation {:title "侧栏"}} {:id "b" :generation {:title "顶栏"}}]
        state (ai/apply-event ai/initial-state {:type "plans" :plans plans})]
    (is (nil? (:plan state)))
    (is (= (second plans) (:plan (ai/select-plan state "b"))))
    (is (= state (ai/select-plan state "invented")))
    (is (= 3 (ai/get-batch-count {:operations (repeat 21 {})})))
    (is (empty? (:plans (ai/apply-event state {:type "execution" :result {:cancelled true}}))))))

(deftest ^:async controlled-design-api-writes-enter-native-undo-and-redo
  (let [file  (cthf/sample-file :ai-undo)
        store (ths/setup-store file {:renderer :svg})
        path  [:files (:id file) :data :pages-index (cthf/current-page-id file) :objects]]
    (await
     (mock/with-mocks* {st/state store st/stream (ptk/input-stream store)}
       (st/emit! (tohs/watch-undo-stack))
       (let [^js context (api/create-context (str uuid/zero))
             ^js history (.-history context)
             block       (.undoBlockBegin history)
             ^js shape   (.createRectangle context)
             id          (uuid/uuid (.-id shape))]
         (await (async/wait-for #(get-in @store (conj path id)) "created real rectangle"))
         (set! (.-fills shape) #js [#js {:fillColor "#0000FF" :fillOpacity 0.5}])
         (set! (.-borderRadius shape) 16)
         (.resize shape 120 60)
         (await (async/wait-for #(= 120 (get-in @store (conj path id :width))) "resized real rectangle"))
         (.undoBlockFinish history block)
         (await (async/wait-for #(seq (get-in @store [:workspace-undo :items])) "native undo entry"))
         (is (= 1 (count (get-in @store [:workspace-undo :items]))))
         (is (= "#0000ff" (str/lower-case (get-in @store (conj path id :fills 0 :fill-color)))))
         (st/emit! dwu/undo)
         (await (async/wait-for #(nil? (get-in @store (conj path id))) "undo created rectangle"))
         (is (nil? (get-in @store (conj path id))))
         (st/emit! dwu/redo)
         (await (async/wait-for #(get-in @store (conj path id)) "redo created rectangle"))
         (is (= [120 60 0.5]
                ((juxt :width :height #(get-in % [:fills 0 :fill-opacity])) (get-in @store (conj path id)))))
         (is (= [16 16 16 16] ((juxt :r1 :r2 :r3 :r4) (get-in @store (conj path id))))))))))

(deftest previews-rectangle-radius-including-zero-and-independent-corners
  (is (= "四角统一圆角：0" (ai/get-operation-summary {:borderRadius 0})))
  (is (= "圆角（左上/右上/右下/左下）：1 / 2 / 3 / 4"
         (ai/get-operation-summary {:cornerRadii [1 2 3 4]}))))

(deftest ^:async generated-page-hierarchy-keeps-absolute-positions-and-native-undo
  (let [file  (cthf/sample-file :ai-layout)
        store (ths/setup-store file {:renderer :svg})
        path  [:files (:id file) :data :pages-index (cthf/current-page-id file) :objects]]
    (await
     (mock/with-mocks* {st/state store st/stream (ptk/input-stream store)}
       (st/emit! (tohs/watch-undo-stack))
       (let [^js context (api/create-context (str uuid/zero))
             ^js history (.-history context)
             block       (.undoBlockBegin history)
             ^js board   (.createBoard context)
             ^js region  (.createBoard context)
             ^js title   (.createText context "设备概览")
             board-id    (uuid/uuid (.-id board))
             region-id   (uuid/uuid (.-id region))
             title-id    (uuid/uuid (.-id title))]
         (await (async/wait-for #(get-in @store (conj path title-id)) "created editable text"))
         (.appendChild board region)
         (.appendChild region title)
         (.resize board 1200 800)
         (set! (.-x board) 1600)
         (set! (.-y board) 0)
         (.resize region 1152 200)
         (set! (.-x region) 1624)
         (set! (.-y region) 24)
         (set! (.-growType title) "fixed")
         (.resize title 300 48)
         (set! (.-x title) 1648)
         (set! (.-y title) 48)
         (await (async/wait-for #(= 1648 (get-in @store (conj path title-id :x))) "positioned nested title"))
         (is (= board-id (get-in @store (conj path region-id :parent-id))))
         (is (= region-id (get-in @store (conj path title-id :parent-id))))
         (is (= [1648 48 300 48]
                ((juxt :x :y :width :height) (get-in @store (conj path title-id)))))
         (.undoBlockFinish history block)
         (await (async/wait-for #(seq (get-in @store [:workspace-undo :items])) "page undo entry"))
         (st/emit! dwu/undo)
         (await (async/wait-for #(nil? (get-in @store (conj path board-id))) "undo whole page batch"))
         (is (nil? (get-in @store (conj path title-id)))))))))

(deftest shows-plan-until-confirmation-and-keeps-verified-step-results
  (let [plan   {:id "plan" :operations [{:tool "set_fill"}]}
        ready  (-> (assoc ai/initial-state :busy true)
                   (ai/apply-event {:type "plan" :plan plan})
                   (ai/apply-event {:type "done" :answer "请确认" :citedShapeIds []}))
        result {:status "partial" :steps [{:status "success"} {:status "failed"}]}
        done   (ai/apply-event ready {:type "execution" :result result})]
    (is (= plan (:plan ready)))
    (is (false? (:busy ready)))
    (is (nil? (:execution ready)))
    (is (nil? (:plan done)))
    (is (= result (:execution done)))
    (is (nil? (:plan (ai/apply-event ready {:type "error" :message "计划失效"}))))))

(deftest rejects-provisional-answer-after-stream-error
  (let [state (-> (assoc ai/initial-state :busy true)
                  (ai/apply-event {:type "delta" :text "尚未校验的回答"})
                  (ai/apply-event {:type "error" :message "连接中断"}))]
    (is (= "" (:answer state)))
    (is (false? (:busy state)))
    (is (empty? (:messages state)))))

(deftest preserves-validated-citations-with-their-snapshot
  (let [context {:page {:id "page"} :shapes [{:id "shape" :name "画板"}]}
        state   (-> ai/initial-state
                    (ai/apply-event {:type "context" :context context})
                    (ai/apply-event {:type "done" :answer "画板" :citedShapeIds ["shape"]}))]
    (is (= context (get-in state [:messages 0 :context])))
    (is (= ["shape"] (get-in state [:messages 0 :citations])))))

(deftest explains-why-the-editor-cannot-connect
  (is (= :unavailable (:status (ai/get-connection-state false {}))))
  (is (= :settings (:action (ai/get-connection-state true {:enabled false}))))
  (is (= :settings (:action (ai/get-connection-state true {:enabled true :token-valid false}))))
  (is (= :connect (:action (ai/get-connection-state true {:enabled true :token-valid true :connection-status "disconnected"})))))

(deftest requires-an-authenticated-editor-session-before-sending
  (let [connecting {:enabled true :token-valid true :connection-status "connecting"}
        connected  {:enabled true :token-valid true :connection-status "connected"}]
    (is (= :connecting (:status (ai/get-connection-state true connecting))))
    (is (nil? (:action (ai/get-connection-state true connecting))))
    (is (not= :ready (:status (ai/get-connection-state true connected))))
    (is (= :ready (:status (ai/get-connection-state true (assoc connected :session-id "editor-tab")))))))
