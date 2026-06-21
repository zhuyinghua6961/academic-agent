package com.academicagent.platform.research.mapper;

import java.util.List;

import com.academicagent.platform.research.entity.Message;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface MessageMapper extends BaseMapper<Message> {

    default List<Message> findByThreadIdOrderByCreatedAtAsc(String threadId) {
        return selectList(Wrappers.<Message>lambdaQuery()
                .eq(Message::getThreadId, threadId)
                .orderByAsc(Message::getCreatedAt));
    }
}
